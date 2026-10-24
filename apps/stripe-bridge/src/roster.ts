// The roster is a projection of the same identities the access-control paths
// act on. Billing selection affects presentation, never identity or standing.
import { everyRecord, identityFor, type Identity, type IdentitySnapshot } from '@/identity.js'
import { type Tier, tierDownloads, tierServerLibraries } from '@/tiers.js'
import { type MemberTag, strongestAcross } from '@/standing.js'
import type {
  CustomerRow,
  Member,
  PlexAccess,
  WizarrInvitation,
  WizarrLibrary,
  WizarrUser,
} from '@/types.js'

type LibraryMap = Readonly<Record<string, readonly string[]>>
const distinct = <T>(items: readonly T[]): T[] => [...new Set(items)]
const byName = (members: readonly Member[]): Member[] =>
  members
    .map((member) => ({ member, key: member.member.toLowerCase() }))
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ member }) => member)

type TierGrant = Readonly<{
  tier: Tier | 'unknown'
  downloads: boolean | null
  entitled: LibraryMap
}>
const tierGrant = ({
  recorded: tier,
  libraries,
}: {
  recorded: Tier | null
  libraries: readonly WizarrLibrary[]
}): TierGrant =>
  tier === null
    ? { tier: 'unknown', downloads: null, entitled: {} }
    : {
        tier,
        downloads: tierDownloads(tier),
        entitled: tierServerLibraries({ tier, libraries }),
      }

/** A subscriber not yet holding a Wizarr record. */
export const memberFromCustomer = ({
  email,
  row,
  libraries,
}: {
  email: string
  row: CustomerRow
  libraries: readonly WizarrLibrary[]
}): Member => ({
  member: email.split('@')[0] ?? '',
  email,
  ...tierGrant({ recorded: row.tier, libraries }),
  expires: null,
  servers: [],
  libraries: {},
  subscribed: row.subscribed,
  payment_state: row.payment_state,
  invited_at: row.invited_at,
  customer_id: row.customer_id,
  stripe_email: null,
})

type BillingAccount = Readonly<{ email: string; row: CustomerRow }>

/**
 * All accounts remain in the identity. For the single display slot prefer a
 * confirmed payer, then an explicit admin link, then the member's own account.
 * Equal candidates sort by address, not database iteration order.
 */
const primaryBilling = ({
  identity,
  customers,
  links,
}: {
  identity: Identity
  customers: ReadonlyMap<string, CustomerRow>
  links: ReadonlyMap<string, string>
}): BillingAccount | null => {
  const rank = ({ email, row }: BillingAccount): number =>
    (row.subscribed ? 4 : 0) +
    (links.has(email) ? 2 : 0) +
    (email === identity.primaryAddress ? 1 : 0)
  return (
    [...customers]
      .filter(([email]) => identity.addresses.has(email))
      .map(([email, row]) => ({ email, row }))
      .toSorted(
        (a, b) => rank(b) - rank(a) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
      )[0] ?? null
  )
}

/** One resolved person, using every record but one stable display address. */
const memberOf = ({
  identity,
  snapshot,
  customers,
  libraries,
}: {
  identity: Identity
  snapshot: IdentitySnapshot
  customers: ReadonlyMap<string, CustomerRow>
  libraries: readonly WizarrLibrary[]
}): Member => {
  const records = everyRecord({ snapshot, identity })
  const first =
    records.find(
      (record) => (record.email ?? '').trim().toLowerCase() === identity.primaryAddress,
    ) ?? records[0]
  const email = (first?.email ?? '').trim() || (identity.primaryAddress ?? '')
  const billing = primaryBilling({ identity, customers, links: snapshot.links })
  const row = billing?.row ?? null
  const grant = tierGrant({ recorded: row?.tier ?? null, libraries })
  const servers = distinct(
    records.flatMap((record) => (record.server ? [record.server] : [])),
  ).toSorted()
  return {
    member: first?.username ?? email.split('@')[0] ?? '',
    email,
    ...grant,
    servers,
    libraries: Object.fromEntries(servers.map((server) => [server, grant.entitled[server] ?? []])),
    expires: records.reduce<string | null>(
      (latest, record) =>
        record.expires && (latest === null || record.expires > latest) ? record.expires : latest,
      null,
    ),
    subscribed: row?.subscribed ?? false,
    payment_state: row?.payment_state ?? null,
    invited_at: row?.invited_at ?? null,
    customer_id: row?.customer_id ?? null,
    stripe_email: billing !== null && billing.email !== email.toLowerCase() ? billing.email : null,
  }
}

const withShare = ({ member, access }: { member: Member; access: PlexAccess }): Member => {
  const key = member.email.toLowerCase()
  const shares = member.email && Object.hasOwn(access, key) ? access[key] : undefined
  if (shares === undefined || Object.keys(shares).length === 0) return member
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
}

export const withPlexAccess = ({
  members,
  access,
}: {
  members: readonly Member[]
  access: PlexAccess | null
}): Member[] =>
  access === null ? [...members] : members.map((member) => withShare({ member, access }))

export type Overrides = Readonly<{
  tags: ReadonlyMap<string, MemberTag>
  downloads: ReadonlyMap<string, boolean>
}>
export type Finishing = Overrides & Readonly<{ access: PlexAccess | null }>

/** Standalone rows may only know their displayed and billing addresses. */
const displayedAddresses = (member: Member): ReadonlySet<string> =>
  new Set([member.email.toLowerCase(), ...(member.stripe_email ? [member.stripe_email] : [])])

export const finishMember = ({
  member,
  finishing,
  addresses = displayedAddresses(member),
}: {
  member: Member
  finishing: Finishing
  addresses?: ReadonlySet<string>
}): Member => ({
  ...(finishing.access === null ? member : withShare({ member, access: finishing.access })),
  tag: strongestAcross({ tags: finishing.tags, addresses }),
  downloads: finishing.downloads.get(member.email.toLowerCase()) ?? member.downloads,
})

export const withOverrides = ({
  members,
  tags,
  downloads,
}: Overrides & { members: readonly Member[] }): Member[] =>
  members.map((member) => finishMember({ member, finishing: { access: null, tags, downloads } }))

type Sources = Readonly<{
  users: readonly WizarrUser[]
  libraries: readonly WizarrLibrary[]
  invitations: readonly WizarrInvitation[]
  customers: ReadonlyMap<string, CustomerRow>
  links: ReadonlyMap<string, string>
  finishing?: Finishing
}>

/** Every person exactly once, whether joined or pending, with all payers retained. */
export const assembleMembers = ({
  users,
  libraries,
  invitations,
  customers,
  links,
  finishing,
}: Sources): Member[] => {
  const snapshot: IdentitySnapshot = {
    users,
    invitations,
    links,
    invites: new Map(
      [...customers].flatMap(([email, row]) =>
        row.invite_code ? [[email, row.invite_code] as const] : [],
      ),
    ),
  }
  const seeds = distinct([
    ...users.map((user) => (user.email ?? '').trim().toLowerCase()),
    ...customers.keys(),
  ]).filter((seed) => !!seed)
  const identities = seeds.reduce((found, email) => {
    const identity = identityFor({
      snapshot,
      email,
      inviteCode: snapshot.invites.get(email) ?? null,
    })
    const key = identity.primaryAddress ?? email
    if (!found.has(key)) found.set(key, identity)
    return found
  }, new Map<string, Identity>())
  // Local Plex accounts with no address are displayable by username, but
  // a username must never be passed off as an email to identity resolution.
  const claimedIds = new Set(
    [...identities.values()].flatMap((identity) =>
      everyRecord({ snapshot, identity }).map((record) => record.id),
    ),
  )
  const localAccounts = users
    .filter((user) => !(user.email ?? '').trim() && !!user.username && !claimedIds.has(user.id))
    .reduce((found, user) => {
      const key = (user.username ?? '').toLowerCase()
      const previous = found.get(key)
      found.set(key, {
        primaryAddress: null,
        addresses: new Set(),
        via: 'none',
        records: [...(previous?.records ?? []), user],
      })
      return found
    }, new Map<string, Identity>())
  const members = [...identities.values(), ...localAccounts.values()].map((identity) => {
    const member = memberOf({ identity, snapshot, customers, libraries })
    return finishing === undefined
      ? member
      : finishMember({ member, finishing, addresses: identity.addresses })
  })
  return byName(members)
}

/** Joined-only convenience for callers holding no invitation or link evidence. */
export const dedupeMembers = ({
  users,
  customers,
  libraries,
}: {
  users: readonly WizarrUser[]
  customers: ReadonlyMap<string, CustomerRow>
  libraries: readonly WizarrLibrary[]
}): Member[] => assembleMembers({ users, customers, libraries, invitations: [], links: new Map() })
