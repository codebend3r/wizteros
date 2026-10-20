import { redeemerRecord } from '@/clients/wizarr.js'
import type { WizarrInvitation, WizarrUser } from '@/types.js'

// Who a member is: every address that belongs to them and every Wizarr record
// they hold. The webhook handlers, the sweeps and the admin routes each used
// to answer this from their own subset of the evidence; this is the one
// answer, worked out from data fetched once rather than one service call per
// guess.

/** What identity is resolved from, fetched once per unit of work. */
export type IdentitySnapshot = Readonly<{
  /** Every Wizarr user record (one per person per server). */
  users: readonly WizarrUser[]
  /** Every Wizarr invitation; only read to follow an invite code to its redeemer. */
  invitations: readonly WizarrInvitation[]
  /** Admin-stated links, lowercased payer address -> lowercased Plex address. */
  links: ReadonlyMap<string, string>
}>

export type Identity = Readonly<{
  /**
   * Every lowercased address of the person: the one asked about, the Plex
   * account that redeemed their invite, and both halves of any admin link.
   */
  addresses: ReadonlySet<string>
  /** The Wizarr records the person holds right now, found as `identityFor` describes. */
  records: readonly WizarrUser[]
}>

/** A record's email lowercased, '' when it has none. */
const emailOf = (user: WizarrUser): string => (user.email ?? '').toLowerCase()

/** Every record under one lowercased address. */
const recordsAt = ({
  users,
  address,
}: {
  users: readonly WizarrUser[]
  address: string
}): WizarrUser[] => users.filter((user) => emailOf(user) === address)

/** The record that redeemed the invite with this code, or null when none resolves. */
const redeemerOf = ({
  snapshot,
  inviteCode,
}: {
  snapshot: IdentitySnapshot
  inviteCode: string | null
}): WizarrUser | null => {
  const invitation = inviteCode
    ? snapshot.invitations.find((row) => row.code === inviteCode)
    : undefined
  return invitation ? redeemerRecord({ invitation, users: snapshot.users }) : null
}

/**
 * The records the Plex account that redeemed an invite holds on every server.
 *
 * A redeemer with no email of its own cannot fan out to its sibling servers;
 * the one record that redeemed the invite is still the right thing to act on.
 */
const redeemerRecords = ({
  users,
  redeemer,
}: {
  users: readonly WizarrUser[]
  redeemer: WizarrUser | null
}): WizarrUser[] => {
  if (redeemer === null) {
    return []
  }
  const address = emailOf(redeemer)
  return address === '' ? [redeemer] : recordsAt({ users, address })
}

/**
 * Every address linked to any of `seeds`, the seeds included.
 *
 * Links point payer -> Plex account, so a person is identified by the Plex
 * address: either an address pays for someone (follow the link) or it is the
 * account itself. Both directions matter, since an event can land on either
 * half of the pair. Links never chain (the link route refuses it), so one
 * step in each direction is the whole person.
 */
const linkedTo = ({
  links,
  seeds,
}: {
  links: ReadonlyMap<string, string>
  seeds: readonly string[]
}): ReadonlySet<string> => {
  const owners = new Set(seeds.map((address) => links.get(address) ?? address))
  const payers = [...links].filter(([, plex]) => owners.has(plex)).map(([payer]) => payer)
  return new Set([...seeds, ...owners, ...payers])
}

/**
 * Who `email` is, and what they hold, from one snapshot.
 *
 * Records are found by the address itself, then by the address an admin
 * linked it to, then by the invite stored against the customer (the Stripe
 * email may differ from the Plex account email). The linked address comes
 * second on purpose: it is a stated fact about who this customer is, while
 * the invite code only infers it from a redemption. It is also the only thing
 * that answers for a member who re-subscribed under a re-typed address
 * without ever redeeming the invite that checkout issued. With no email at
 * all, only the invite can answer.
 */
export const identityFor = ({
  snapshot,
  email,
  inviteCode,
}: {
  snapshot: IdentitySnapshot
  email: string | null
  inviteCode: string | null
}): Identity => {
  const address = email ? email.toLowerCase() : null
  const redeemer = redeemerOf({ snapshot, inviteCode })
  const redeemerAddress = redeemer ? emailOf(redeemer) : ''
  const seeds = [address ?? '', redeemerAddress].filter((seed) => seed !== '')
  const addresses = linkedTo({ links: snapshot.links, seeds })
  const byEmail = address ? recordsAt({ users: snapshot.users, address }) : []
  if (byEmail.length > 0) {
    return { addresses, records: byEmail }
  }
  const linked = address ? snapshot.links.get(address) : undefined
  const byLink = linked ? recordsAt({ users: snapshot.users, address: linked }) : []
  return {
    addresses,
    records: byLink.length > 0 ? byLink : redeemerRecords({ users: snapshot.users, redeemer }),
  }
}
