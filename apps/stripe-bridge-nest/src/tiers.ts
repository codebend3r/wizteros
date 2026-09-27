// Which libraries each paid tier grants, resolved from the live Wizarr library
// list rather than declared, plus the health checks that turn a Plex-side
// rename into an alert instead of a silent outage.

import { Logger } from '@nestjs/common'

import type { LiveSections, TierScope, WizarrLibrary } from '@/types.js'

const log = new Logger('bridge')

// Never-share rule: any library named "90. ..." through "99. ...", on any
// server. Name-only and deliberately server-agnostic (see isPrivate).
export const PRIVATE_NAME_RE = /^9\d\./

// The Plex server the paid-entry tiers share from. Meleys carries a copy of
// every library worth sharing, so bronze, silver and youth resolve here alone.
export const SHARE_SERVER = 'Meleys'

// The servers every tier below gold shares from. A set rather than the bare
// name so the entry rule reads the same shape as gold's.
export const ENTRY_SHARE_SERVERS: ReadonlySet<string> = new Set([SHARE_SERVER])

// Retired outright: no tier may resolve a library here and no member may keep a
// record on it. Listed separately from the per-tier rules so widening a tier can
// never quietly readmit it, and it is the ONLY thing holding gold back.
export const RETIRED_SERVERS: ReadonlySet<string> = new Set(['Caraxes'])

// Youth allowlist, matched on library title alone — every shareable library is
// on SHARE_SERVER, so the server half of the key added nothing but a second
// way to drift out of date. The titles are the actual Plex library names with
// the "NN. " ordering prefix stripped; they do not follow the tier's branding.
//
// Matching the title rather than the full name is deliberate. The prefixes are
// display ordering, not identity: regrouping the Plex libraries renumbers them
// without changing what they hold, and an allowlist keyed on the full name
// silently narrows the tier when that happens.
export const YOUTH_LIBRARY_TITLES: ReadonlySet<string> = new Set([
  'Family Movies',
  '4K Family Movies',
  'Kid Shows',
])

// Leading "NN. " ordering prefix on a Plex library name.
export const LIBRARY_PREFIX_RE = /^\d+\.\s*/

// Every known tier and whether it may download, in the order the tiers are
// checked and reported: bronze, silver, gold, youth.
export const TIER_DOWNLOADS: ReadonlyMap<string, boolean> = new Map([
  ['bronze', false],
  ['silver', false],
  ['gold', true],
  ['youth', true],
])

// Pre-rebrand tier names still live in old Stripe metadata and stored DB rows.
export const LEGACY_TIER_ALIASES: ReadonlyMap<string, string> = new Map([['kids', 'youth']])

/** A library row as `staleLibraries` reports it: the row plus Plex's current title. */
export type StaleLibrary = WizarrLibrary & Readonly<{ live_name: string | null }>

/** One Wizarr user record as `staleRecordIds` reads it. */
export type ServerRecord = Readonly<{ id: number; server?: string | null }>

/** Whether a tier's rules include a library, before the server and private filters. */
export type TierWants = (rule: { tier: string; library: WizarrLibrary }) => boolean

/** A string as Python's repr() prints it: single-quoted unless it holds only a single quote. */
const pyReprString = (value: string): string => {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  const body = value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  return quote + (quote === "'" ? body.replaceAll("'", "\\'") : body) + quote
}

/** A value as Python's `%r` would print it, for log lines that quote their input. */
const pyRepr = (value: unknown): string => {
  if (value == null) return 'None'
  if (typeof value === 'string') return pyReprString(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? String(value)
}

/** A value as Python's `%s` would print it: None for a missing value. */
const pyStr = (value: unknown): string => (value == null ? 'None' : String(value))

/**
 * The Plex servers a tier may share from, retired servers already removed.
 *
 * Gold is every server the fleet has except the retired ones, so its answer
 * is read off the library list rather than declared: a NAS added to the fleet
 * is in gold's scope the moment Wizarr lists its libraries, with no code
 * change and no chance of the constant drifting behind the hardware. That
 * makes gold the one denylisted tier, which is why RETIRED_SERVERS is the
 * thing to edit to hold a server back, never a per-tier set. Every other tier
 * stays an exact allowlist match against ENTRY_SHARE_SERVERS.
 */
export const tierShareServers = ({
  tier,
  libraries,
}: {
  tier: string
  libraries: readonly WizarrLibrary[]
}): ReadonlySet<string> => {
  const wanted =
    tier === 'gold'
      ? libraries.flatMap((lib) => (lib.server_name ? [lib.server_name] : []))
      : [...ENTRY_SHARE_SERVERS]
  return new Set(wanted.filter((server) => !RETIRED_SERVERS.has(server)))
}

/** Every server some tier may share from: the only ones an invite can name. */
export const allShareServers = ({
  libraries,
}: {
  libraries: readonly WizarrLibrary[]
}): ReadonlySet<string> =>
  new Set(
    [...TIER_DOWNLOADS.keys()].flatMap((tier) => Array.from(tierShareServers({ tier, libraries }))),
  )

/** A stored tier string mapped through the legacy aliases; no bronze fallback. */
export const canonicalTier = <T>(raw: T): T | string =>
  typeof raw === 'string' ? (LEGACY_TIER_ALIASES.get(raw) ?? raw) : raw

/** Map checkout metadata to a known tier; unknown, missing, or non-string falls back to bronze. */
export const normalizeTier = (raw: unknown): string => {
  const trimmed = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  const tier = LEGACY_TIER_ALIASES.get(trimmed) ?? trimmed
  if (!TIER_DOWNLOADS.has(tier)) {
    log.error(`unknown tier ${pyRepr(raw)} on checkout session; defaulting to bronze`)
    return 'bronze'
  }
  return tier
}

/**
 * Whether a library is in the never-share set (9X. names).
 *
 * Deliberately server-agnostic: the rule matches on name alone, never on
 * server_name, so it fails closed if Wizarr ever returns a null or renamed
 * server_name for a library that should stay private.
 */
export const isPrivate = (library: Pick<WizarrLibrary, 'name'>): boolean =>
  PRIVATE_NAME_RE.test(library.name ?? '')

/** A library's name with its "NN. " ordering prefix stripped. */
export const libraryTitle = (library: Pick<WizarrLibrary, 'name'>): string =>
  (library.name ?? '').replace(LIBRARY_PREFIX_RE, '')

/** Case-insensitive '4K' match on the library name. */
const is4k = (library: WizarrLibrary): boolean => (library.name ?? '').toLowerCase().includes('4k')

/**
 * Whether a library sits on a server this tier is allowed to share from.
 *
 * A missing or null server_name fails closed on every tier, and a retired
 * server is refused before the tier is even consulted, so neither a rename
 * nor a widened tier can leak a retired box's copy.
 *
 * Gold needs no allowlist membership beyond that: it spans the whole fleet,
 * so anything not retired is in scope. Reading it off the library row rather
 * than off tierShareServers keeps this a per-library test with no need to
 * thread the whole list down here.
 */
const isOnShareServer = ({ library, tier }: { library: WizarrLibrary; tier: string }): boolean => {
  const server = library.server_name
  if (!server || RETIRED_SERVERS.has(server)) return false
  return tier === 'gold' || ENTRY_SHARE_SERVERS.has(server)
}

/** Whether a tier's rules include a library (before the server/private filters). */
export const tierWants: TierWants = ({ tier, library }) => {
  if (tier === 'youth') return YOUTH_LIBRARY_TITLES.has(libraryTitle(library))
  if (tier === 'bronze') return !is4k(library)
  // silver / gold: everything
  return true
}

/**
 * Enabled libraries on a tier's servers that its rules include.
 *
 * The server and private filters run last, independent of the tier rules, so
 * no rule change can ever share a private library or resurrect a retired
 * server. `wants` defaults to the real tier rules; tests hand in a broken rule
 * to prove the guards hold without it.
 */
export const shareableLibraries = ({
  tier,
  libraries,
  wants = tierWants,
}: {
  tier: string
  libraries: readonly WizarrLibrary[]
  wants?: TierWants
}): WizarrLibrary[] =>
  libraries
    .filter((library) => !!library.enabled && wants({ tier, library }))
    .filter((library) => isOnShareServer({ library, tier }) && !isPrivate(library))

/**
 * Shareable library names a tier grants, grouped by server name.
 *
 * Keyed by server for the admin UI's per-server breakdown: one entry for the
 * entry tiers, one per fleet server for gold. Derived from the tier rules
 * (what invites are scoped to), not read back from Plex — Wizarr's users API
 * doesn't expose per-user libraries. Unknown tiers grant nothing.
 */
export const tierServerLibraries = ({
  tier,
  libraries,
}: {
  tier: string
  libraries: readonly WizarrLibrary[]
}): Record<string, string[]> => {
  if (!TIER_DOWNLOADS.has(tier)) return {}
  const shareable = shareableLibraries({ tier, libraries })
  const servers = new Set(shareable.flatMap((lib) => (lib.server_name ? [lib.server_name] : [])))
  return Object.fromEntries(
    [...servers].map((server) => [
      server,
      shareable
        .filter((lib) => lib.server_name === server)
        .map((lib) => lib.name ?? '')
        .toSorted(),
    ]),
  )
}

/** Compute an invite's scope for a tier from the live Wizarr library list. */
export const resolveTierAccess = ({
  tier,
  libraries,
  wants = tierWants,
}: {
  tier: string
  libraries: readonly WizarrLibrary[]
  wants?: TierWants
}): TierScope => {
  const shareable = shareableLibraries({ tier, libraries, wants })
  if (tier === 'youth' && shareable.length < YOUTH_LIBRARY_TITLES.size) {
    const found = new Set(shareable.map(libraryTitle))
    const missing = [...YOUTH_LIBRARY_TITLES].filter((title) => !found.has(title)).toSorted()
    log.error(`youth allowlist mismatch on ${SHARE_SERVER}; missing ${pyRepr(missing)}`)
  }
  const allowDownloads = TIER_DOWNLOADS.get(tier)
  if (allowDownloads === undefined) throw new Error(`KeyError: ${pyRepr(tier)}`)
  return {
    library_ids: shareable.map((lib) => lib.id),
    server_ids: [...new Set(shareable.map((lib) => lib.server_id))].toSorted((a, b) => a - b),
    server_names: [
      ...new Set(shareable.flatMap((lib) => (lib.server_name ? [lib.server_name] : []))),
    ].toSorted(),
    allow_downloads: allowDownloads,
  }
}

/**
 * Tiers whose live scope is broken, mapped to a human-readable reason.
 *
 * Empty when every tier resolves. The tier rules match on library names, so
 * a rename on the Plex side silently narrows or empties a tier without any
 * code change — a tier that resolves to nothing cannot issue an invite at
 * all, and its checkouts raise and retry forever. Callers run this against
 * the live library list to turn that silent drift into an alert.
 */
export const tierScopeProblems = ({
  libraries,
}: {
  libraries: readonly WizarrLibrary[]
}): Record<string, string> =>
  Object.fromEntries(
    [...TIER_DOWNLOADS.keys()].flatMap((tier): [string, string][] => {
      const shareable = shareableLibraries({ tier, libraries })
      if (shareable.length === 0) {
        const servers = [...tierShareServers({ tier, libraries })].toSorted().join(', ')
        return [
          [
            tier,
            `no libraries resolved on ${servers}: checkouts for this tier will fail and retry forever`,
          ],
        ]
      }
      if (tier !== 'youth') return []
      const found = new Set(shareable.map(libraryTitle))
      const missing = [...YOUTH_LIBRARY_TITLES].filter((title) => !found.has(title)).toSorted()
      return missing.length > 0
        ? [[tier, `allowlist entries missing from ${SHARE_SERVER}: ${missing.join(', ')}`]]
        : []
    }),
  )

/**
 * Enabled Wizarr library rows whose name Plex no longer answers to.
 *
 * Wizarr caches library names and shares by NAME: at redemption it hands
 * plexapi the cached names for the invite, and plexapi looks each one up on
 * the live server. A rename on the Plex side that Wizarr has not rescanned
 * therefore makes Plex reject every invite carrying the old name, whole
 * ("Plex invitation failed", a KeyError on the stale title). That is how a
 * bronze signup landed with no access on 2026-09-04: "33. Formula 1" had
 * become "22. Formula 1" on Meleys.
 *
 * `live` is plex.liveSections(): server name -> section id -> live title,
 * and the section id is what Wizarr stores as external_id. Each stale row
 * comes back with a `live_name` (the current title, or null when the section
 * is gone). Only rows that can reach an invite count: disabled rows and rows
 * on servers no tier shares from (retired Caraxes) are skipped, as are
 * servers plex.tv does not list and rows without an external_id, where
 * nothing can be checked and unknown is not stale. Null for `live` (no token,
 * plex.tv unreachable) reports nothing stale for the same reason.
 */
export const staleLibraries = ({
  libraries,
  live,
}: {
  libraries: readonly WizarrLibrary[]
  live: LiveSections | null
}): StaleLibrary[] => {
  if (live == null || Object.keys(live).length === 0) return []
  const shareable = allShareServers({ libraries })
  return libraries.flatMap((lib): StaleLibrary[] => {
    const server = lib.server_name
    const sections = server != null && Object.hasOwn(live, server) ? live[server] : undefined
    const externalId = lib.external_id
    if (!lib.enabled || server == null || !shareable.has(server)) return []
    if (sections === undefined || externalId == null || externalId === '' || externalId === 0) {
      return []
    }
    const key = String(externalId)
    const liveName = Object.hasOwn(sections, key) ? (sections[key] ?? null) : null
    return liveName === (lib.name ?? null) ? [] : [{ ...lib, live_name: liveName }]
  })
}

/**
 * The library list with every stale row dropped, each drop logged with its remedy.
 *
 * An invite carrying a stale name grants nothing, because Plex rejects the
 * whole share; one without it grants everything else. The scope check's
 * alert tells the operator to rescan, and the next invite carries the
 * library again.
 */
export const withoutStale = ({
  libraries,
  live,
}: {
  libraries: readonly WizarrLibrary[]
  live: LiveSections | null
}): WizarrLibrary[] => {
  const stale = staleLibraries({ libraries, live })
  stale.forEach((row) => {
    const where = row.live_name
      ? `Plex now calls it ${pyRepr(row.live_name)}`
      : 'it is gone from Plex'
    log.error(
      `dropping stale library ${pyRepr(row.name)} on ${pyStr(row.server_name)} from the invite ` +
        `scope: ${where}; rescan the server's libraries in Wizarr to restore it`,
    )
  })
  const staleIds = new Set(stale.map((row) => row.id))
  return libraries.filter((lib) => !staleIds.has(lib.id))
}

/** The server a stale row is reported under; '?' when it names none. */
const serverOf = (row: StaleLibrary): string => row.server_name || '?'

/**
 * Servers whose Wizarr library cache no longer matches Plex, with a readable reason.
 *
 * Shaped like tierScopeProblems so the scope check can report both in one
 * alert: keyed by "wizarr cache on <server>", empty when the cache is current
 * or when there is nothing to check it against.
 */
export const libraryCacheProblems = ({
  libraries,
  live,
}: {
  libraries: readonly WizarrLibrary[]
  live: LiveSections | null
}): Record<string, string> => {
  const stale = staleLibraries({ libraries, live })
  const byServer = [...new Set(stale.map(serverOf))].map((server): [string, StaleLibrary[]] => [
    server,
    stale.filter((row) => serverOf(row) === server),
  ])
  return Object.fromEntries(
    byServer.map(([server, rows]) => [
      `wizarr cache on ${server}`,
      rows
        .map((row) =>
          row.live_name
            ? `'${pyStr(row.name)}' is now '${row.live_name}' on Plex`
            : `'${pyStr(row.name)}' is gone from Plex`,
        )
        .join('; ') +
        ". Plex rejects every invite carrying a stale name until the server's libraries are " +
        'rescanned in Wizarr',
    ]),
  )
}

/**
 * Record ids that must be disabled before an invite can safely re-scope.
 *
 * Redeeming an invite updates the share in place on every server the invite
 * covers (Wizarr catches Plex's "already sharing" and rewrites the sections),
 * so records on covered servers need no disable and the member keeps access
 * through the invite window. But Wizarr has no per-server unshare — disable
 * severs the whole plex.tv friendship — so if any record sits on a server the
 * new scope does NOT cover (or has no server name), every record is returned
 * and the caller falls back to disable-first (fail closed on stale access).
 *
 * A member holding a record on a server their new tier does not cover (a
 * Caraxes record, or a fleet record under an entry tier) therefore returns
 * the full set: that disable-and-re-join IS the migration onto the covered
 * servers, at the cost of an access gap between the disable and the member
 * redeeming their invite.
 */
export const staleRecordIds = ({
  records,
  coveredServers,
}: {
  records: readonly ServerRecord[]
  coveredServers: Iterable<string>
}): number[] => {
  const covered: ReadonlySet<string> = new Set(coveredServers)
  return records.every((record) => record.server != null && covered.has(record.server))
    ? []
    : records.map((record) => record.id)
}
