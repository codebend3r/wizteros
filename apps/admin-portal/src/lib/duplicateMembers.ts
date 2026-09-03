import type { Member } from '@/lib/adminApi'

/**
 * Find members who are probably the same person under two addresses.
 *
 * A member whose card declines does not always wait for Stripe to retry. Some
 * re-subscribe from scratch, and a re-typed address (jimmyvo767 becoming
 * jimmyvo768) opens a second Stripe customer instead of fixing the first. The
 * bridge keys everything on email, so the two never meet: the new payment
 * cannot rescue the old member's access, and the old subscription keeps
 * dunning against a card nobody is watching. Both rows then read as healthy
 * subscribers and the only visible symptom is two similar names in a list of
 * fifty.
 *
 * Two signals, both cheap enough to run over the whole table:
 *
 * - the same mailbox written differently. Gmail ignores dots and anything
 *   after a `+`, so `jim.vo+plex@gmail.com` and `jimvo@gmail.com` deliver to
 *   one inbox and bill as two customers.
 * - a single typed character apart, which is what a re-typed address looks
 *   like: one substitution, insertion, or deletion.
 *
 * Deliberately a hint, never an action. It surfaces the pair for a human to
 * reconcile in Stripe; nothing here merges, cancels, or refunds anything.
 */

/** Gmail's own rules: dots are ignored and `+tag` is stripped from the mailbox. */
const canonicalize = (email: string): string => {
  const lowered = email.trim().toLowerCase()
  const at = lowered.lastIndexOf('@')
  if (at < 1) {
    return lowered
  }
  const local = lowered.slice(0, at)
  const domain = lowered.slice(at + 1)
  const mailbox = (local.split('+')[0] ?? local).split('.').join('')
  return `${mailbox}@${domain}`
}

/**
 * True when `a` and `b` are at most one edit apart (substitution, insertion,
 * or deletion). Short-circuits on a length gap of two or more, so the scan
 * stays linear in the compared pair rather than building a full edit matrix.
 */
const isOneEditApart = (a: string, b: string): boolean => {
  if (a === b) {
    return false
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (longer.length - shorter.length > 1) {
    return false
  }
  const firstDiff = [...longer].findIndex((char, index) => shorter[index] !== char)
  if (firstDiff === -1) {
    // Identical up to the shorter string: one trailing character apart.
    return longer.length - shorter.length === 1
  }
  const rest =
    shorter.length === longer.length
      ? shorter.slice(firstDiff + 1) === longer.slice(firstDiff + 1) // substitution
      : shorter.slice(firstDiff) === longer.slice(firstDiff + 1) // insertion
  return rest
}

/**
 * Each flagged email (lowercased) mapped to the addresses it looks like a
 * duplicate of.
 *
 * Only members the bridge has a payment signal for are compared. Declined and
 * uninvited rows are mostly stale addresses that never became anyone, and
 * pairing them produces noise that trains the reader to ignore the badge.
 */
export const findDuplicateTwins = ({
  members,
}: {
  members: ReadonlyArray<Member>
}): ReadonlyMap<string, ReadonlyArray<string>> => {
  const candidates = members
    .filter((member) => !!member.email && (member.subscribed || member.tag === 'vip'))
    .map((member) => ({
      email: member.email.toLowerCase(),
      canonical: canonicalize(member.email),
    }))

  return candidates.reduce<Map<string, ReadonlyArray<string>>>((twins, member, index) => {
    const matches = candidates
      .filter(
        (other, otherIndex) =>
          otherIndex !== index &&
          (other.canonical === member.canonical ||
            isOneEditApart(other.canonical, member.canonical)),
      )
      .map((other) => other.email)
    return matches.length ? twins.set(member.email, matches) : twins
  }, new Map<string, ReadonlyArray<string>>())
}

/** The emails (lowercased) flagged above, when only the fact matters. */
export const findDuplicateEmails = ({
  members,
}: {
  members: ReadonlyArray<Member>
}): ReadonlySet<string> => new Set(findDuplicateTwins({ members }).keys())
