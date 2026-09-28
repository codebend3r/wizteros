import { redeemerEmail } from '@/clients/wizarr.js'
import { canonicalTier, TIER_DOWNLOADS, tierServerLibraries } from '@/tiers.js'
import type {
  CustomerRow,
  Member,
  PlexAccess,
  WizarrInvitation,
  WizarrLibrary,
  WizarrUser,
} from '@/types.js'

// Building the members list out of what Wizarr, Stripe and the store each know.
//
// Pure functions of their arguments: no HTTP, no database, no snapshot. The
// admin controller does the reading and hands the four sources in, which is
// what lets the list route serve them from its warm snapshot while the member
// page fetches the same shapes live.
//
// Ordering is part of what the portal is served: a Map keeps the position a
// key was first set at, and `toSorted` is stable.

/** Server name -> library names, the shape of `libraries` and `entitled`. */
type LibraryMap = Readonly<Record<string, readonly string[]>>

/**
 * A customer row standing for a Plex account under another address: the row
 * itself, the Stripe address it was keyed by, and whether an admin stated the
 * link rather than a redeemed invite implying it.
 */
export type LinkedCustomer = CustomerRow &
  Readonly<{
    stripe_email: string
    manual_link: boolean
  }>

/**
 * Whatever billing row a member is read from: their own customer row, a linked
 * one, or nothing at all, so every field may be missing.
 */
type BillingRow = Partial<CustomerRow> & Readonly<{ stripe_email?: string; manual_link?: boolean }>

/** The items in first-seen order with duplicates dropped. */
const distinct = <T>(items: readonly T[]): T[] => [...new Set(items)]

/** The members by lowercased name, stable for equal names. */
const byName = (members: readonly Member[]): Member[] =>
  members
    .map((member) => ({ member, key: member.member.toLowerCase() }))
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ member }) => member)

/** A tier's downloads default; null for an unknown tier. */
const tierDownloads = (tier: string): boolean | null =>
  tier === 'unknown' ? null : (TIER_DOWNLOADS.get(tier) ?? null)

/** The stored tier mapped through the legacy aliases, "unknown" when missing or empty. */
const resolvedTier = (raw: string | null | undefined): string =>
  canonicalTier(raw ?? null) || 'unknown'

/**
 * Invite code -> the Plex account email that redeemed it, both lowercased.
 *
 * This is the only link between a Stripe customer and a member who signed up
 * to Plex under a different address. The bridge issues the invite against the
 * checkout email; whoever redeems it is the person paying, whatever their
 * Plex account is called.
 */
export const plexEmailByInvite = ({
  invitations,
  users,
}: {
  invitations: readonly WizarrInvitation[]
  users: readonly WizarrUser[]
}): ReadonlyMap<string, string> => {
  const resolved = new Map(
    invitations.map(
      (invitation) =>
        [(invitation.code ?? '').toLowerCase(), redeemerEmail({ invitation, users })] as const,
    ),
  )
  return new Map(
    [...resolved].flatMap(([code, email]) => (code && email ? [[code, email] as const] : [])),
  )
}

/**
 * Plex email -> the Stripe customer row belonging to that person.
 *
 * Only rows whose email differs from the Plex email they resolve to are
 * returned: a matching pair needs no linking, and keeping the map to real
 * mismatches means the caller can treat a hit as "these are two addresses for
 * one person" without re-comparing.
 *
 * Two sources, manual first. The redeemed invite answers on its own for
 * anyone who signed up through their own checkout. It cannot answer for
 * someone who re-subscribed under a re-typed address while already holding
 * access: that invite is never redeemed, so `used_by` stays null and the
 * paying customer keeps standing as a second member. `member_links` is the
 * admin's answer for those, and it is marked so callers can tell a stated
 * link from an inferred one.
 */
export const customerByPlexEmail = ({
  customers,
  plexEmailByInvite: byInvite,
  manualLinks = new Map(),
}: {
  customers: ReadonlyMap<string, CustomerRow>
  plexEmailByInvite: ReadonlyMap<string, string>
  manualLinks?: ReadonlyMap<string, string>
}): ReadonlyMap<string, LinkedCustomer> =>
  new Map(
    [...customers].flatMap(([customerEmail, row]) => {
      const code = (row.invite_code ?? '').toLowerCase()
      const manual = manualLinks.get(customerEmail) ?? ''
      // `||`, not `??`: an empty stored link counts as no link.
      const plexEmail = manual || (code ? (byInvite.get(code) ?? '') : '')
      return plexEmail && plexEmail !== customerEmail
        ? [[plexEmail, { ...row, stripe_email: customerEmail, manual_link: !!manual }] as const]
        : []
    }),
  )

/** One person gathered from their per-server Wizarr records. */
type Person = Readonly<{
  member: string
  email: string
  servers: readonly string[]
  expires: string | null
}>

/** The users grouped into people, keyed by lowercased email (else username), first-seen order. */
const people = (users: readonly WizarrUser[]): Person[] => {
  const keyed = users
    .map((user) => {
      const email = (user.email ?? '').trim()
      const username = user.username ?? ''
      return { user, email, username, key: (email || username).toLowerCase() }
    })
    .filter(({ key }) => !!key)
  return distinct(keyed.map(({ key }) => key)).map((key) => {
    const records = keyed.filter((record) => record.key === key)
    // The first record's name and email stand for the person.
    const [first] = records
    return {
      member: first?.username ?? '',
      email: first?.email ?? '',
      servers: distinct(records.flatMap(({ user }) => (user.server ? [user.server] : []))),
      // the latest expiry across records; a tie keeps the first
      expires: records.reduce<string | null>(
        (latest, { user }) =>
          user.expires && (latest === null || user.expires > latest) ? user.expires : latest,
        null,
      ),
    }
  })
}

/**
 * Collapse per-server Wizarr records into one entry per person.
 *
 * Key is the lowercased email (falling back to username). Aggregates the
 * servers a person appears on and keeps the latest expiry across records.
 * Tier and invited_at are joined from the bridge's store; downloads and
 * per-server library access derive from tier.
 */
export const dedupeMembers = ({
  users,
  customers,
  libraries,
  linked = new Map(),
}: {
  users: readonly WizarrUser[]
  customers: ReadonlyMap<string, CustomerRow>
  libraries: readonly WizarrLibrary[]
  linked?: ReadonlyMap<string, LinkedCustomer>
}): Member[] =>
  byName(
    people(users).map((person) => {
      const key = person.email ? person.email.toLowerCase() : ''
      // Their own address first; the invite linkage only answers for members
      // whose Plex account is under a different email than they pay with.
      // A manual link outranks even that: "they pay under X" is only ever
      // stated about someone whose own address is the dead or failing one,
      // so billing has to read from the customer the admin pointed at.
      const link: BillingRow = linked.get(key) ?? {}
      const own = customers.get(key)
      const row: BillingRow = link.manual_link ? link : (own ?? link)
      const tier = resolvedTier(row.tier)
      const servers = [...person.servers].toSorted()
      const tierLibraries: LibraryMap = tierServerLibraries({ tier, libraries })
      return {
        member: person.member,
        email: person.email,
        tier,
        downloads: tierDownloads(tier),
        expires: person.expires,
        servers,
        libraries: Object.fromEntries(
          servers.map((server) => [server, tierLibraries[server] ?? []]),
        ),
        // The tier rules alone, NOT narrowed to the servers this member
        // happens to hold records on — that is what makes it comparable to
        // the live plex.tv share, which is how the member page tells
        // "entitled to" apart from "actually sharing".
        entitled: tierLibraries,
        subscribed: !!row.subscribed,
        payment_state: row.payment_state ?? null,
        invited_at: row.invited_at ?? null,
        customer_id: row.customer_id ?? null,
        // Only set when the member pays under a different address than
        // their Plex account uses. Equal addresses are the norm and would
        // just be the same string twice in the UI.
        stripe_email: row.stripe_email ?? null,
      }
    }),
  )

/**
 * A table row for a subscriber the bridge knows who hasn't joined Wizarr yet.
 *
 * Their tier is known, so `entitled` (what redeeming would grant them) is
 * known too and the member page can render a real Servers section instead of
 * an empty one. `servers` and `libraries` stay empty on purpose: this member
 * holds no Wizarr record, and the only other thing that could give them
 * access is a live plex.tv share, which withPlexAccess unions in afterwards.
 * Filling them from the tier instead is how a locked-out member came to read
 * "1 server, 19 libraries" on /manage while they could not watch anything at
 * all.
 */
export const memberFromCustomer = ({
  email,
  row,
  libraries,
}: {
  email: string
  row: CustomerRow
  libraries: readonly WizarrLibrary[]
}): Member => {
  const tier = resolvedTier(row.tier)
  return {
    member: email.split('@')[0] ?? '',
    email,
    tier,
    downloads: tierDownloads(tier),
    expires: null,
    servers: [],
    libraries: {},
    entitled: tierServerLibraries({ tier, libraries }),
    subscribed: !!row.subscribed,
    payment_state: row.payment_state,
    invited_at: row.invited_at,
    customer_id: row.customer_id,
    // Nothing to contrast with: this row IS the Stripe address, and no
    // Plex account has claimed it yet.
    stripe_email: null,
  }
}

/**
 * Union each member's live plex.tv share into their servers and libraries.
 *
 * plex.tv is ground truth for what a member can actually see: it covers
 * legacy shares that never went through an invite, and members whose tier
 * was never recorded (whose tier-derived library list is empty). `access` is
 * the bulk lookup from fetchUpstream; null (no token, or plex.tv failed)
 * leaves the tier-derived values in place rather than failing the whole list.
 */
export const withPlexAccess = ({
  members,
  access,
}: {
  members: readonly Member[]
  access: PlexAccess | null
}): Member[] => {
  if (access === null) {
    return [...members]
  }
  return members.map((member) => {
    const key = member.email.toLowerCase()
    const shares = member.email && Object.hasOwn(access, key) ? access[key] : undefined
    // An empty share map has nothing to union in.
    if (shares === undefined || Object.keys(shares).length === 0) {
      return member
    }
    const servers = distinct([...member.servers, ...Object.keys(shares)]).toSorted()
    return {
      ...member,
      servers,
      libraries: Object.fromEntries(
        servers.map((server) => [
          server,
          Object.hasOwn(shares, server)
            ? (shares[server]?.libraries ?? [])
            : (member.libraries[server] ?? []),
        ]),
      ),
    }
  })
}

/**
 * Stamp each member with its admin overrides.
 *
 * tag: the manual designation ("vip"/"hvu"/"banned"), null untagged.
 * downloads: the admin's toggle wins over the tier-derived value when set.
 */
export const withOverrides = ({
  members,
  tags,
  downloads,
}: {
  members: readonly Member[]
  tags: ReadonlyMap<string, string>
  downloads: ReadonlyMap<string, boolean>
}): Member[] =>
  members.map((member) => {
    const key = member.email.toLowerCase()
    return {
      ...member,
      tag: tags.get(key) ?? null,
      downloads: downloads.get(key) ?? member.downloads,
    }
  })

/**
 * Every member the two sources know, as one list sorted by name.
 *
 * Wizarr's user list only holds people who redeemed an invite, so subscribers
 * still sitting on a pending one are unioned in from the bridge's customer
 * map. A customer already shown as someone else's Stripe address is left out
 * of that union: standing as its own row as well is the "two entries for one
 * person" the linkage exists to collapse.
 */
export const assembleMembers = ({
  users,
  libraries,
  invitations,
  customers,
  links,
}: {
  users: readonly WizarrUser[]
  libraries: readonly WizarrLibrary[]
  invitations: readonly WizarrInvitation[]
  customers: ReadonlyMap<string, CustomerRow>
  links: ReadonlyMap<string, string>
}): Member[] => {
  const linked = customerByPlexEmail({
    customers,
    plexEmailByInvite: plexEmailByInvite({ invitations, users }),
    manualLinks: links,
  })
  const members = dedupeMembers({ users, customers, libraries, linked })
  const joined = new Set(members.flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])))
  const claimed = new Set(members.flatMap((m) => (m.stripe_email ? [m.stripe_email] : [])))
  const pending = [...customers]
    .filter(([email]) => !joined.has(email) && !claimed.has(email))
    .map(([email, row]) => memberFromCustomer({ email, row, libraries }))
  return byName([...members, ...pending])
}
