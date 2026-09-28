// Tier scopes checked against a recorded snapshot of the real Wizarr library list.
//
// Every other tier test builds its own fixture, so the fixture and the rules are
// written together and always agree — which is why a Plex-side rename could empty
// the youth tier for weeks without a single red test. This module reads a
// committed snapshot of what Wizarr actually returns instead.
//
// Refresh it with `bun run refresh:libraries` after any Plex library rename; the
// diff is the review, and these assertions are what fail if a rename narrows or
// empties a tier.

import { describe, expect, it } from 'vitest'

import { fixtureJson } from '@/test/support.js'
import {
  LIBRARY_PREFIX_RE,
  PRIVATE_NAME_RE,
  RETIRED_SERVERS,
  SHARE_SERVER,
  type Tier,
  TIERS,
  YOUTH_LIBRARY_TITLES,
  resolveTierAccess,
  tierScopeProblems,
  tierServerLibraries,
} from '@/tiers.js'
import type { TierScope, WizarrLibrary } from '@/types.js'

/** One row of the recorded snapshot: every field Wizarr returns, all present. */
type SnapshotLibrary = WizarrLibrary &
  Readonly<{ name: string; server_name: string; enabled: boolean }>

/** Whether a value is a plain JSON object. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a value is one fully populated Wizarr library row. */
const isSnapshotLibrary = (value: unknown): value is SnapshotLibrary =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.server_id === 'number' &&
  typeof value.server_name === 'string' &&
  typeof value.enabled === 'boolean'

/** Whether a value is the snapshot file's shape: `{ libraries: [...] }`. */
const isSnapshot = (value: unknown): value is Readonly<{ libraries: SnapshotLibrary[] }> =>
  isRecord(value) && Array.isArray(value.libraries) && value.libraries.every(isSnapshotLibrary)

const SNAPSHOT = fixtureJson('live-libraries.json')

/** The snapshot's libraries, or a thrown error naming the fixture if it drifted shape. */
const loadLibraries = (): readonly SnapshotLibrary[] => {
  if (!isSnapshot(SNAPSHOT)) throw new Error('live-libraries.json is not a Wizarr library list')
  return SNAPSHOT.libraries
}

const LIBRARIES = loadLibraries()

const SORTED_TIERS = TIERS.toSorted()
const ENTRY_TIERS = SORTED_TIERS.filter((tier) => tier !== 'gold')

/** The resolved access for a tier against the recorded snapshot. */
const scope = (tier: Tier): TierScope => resolveTierAccess({ tier, libraries: LIBRARIES })

/** Library names a tier grants on the share server, sorted. */
const names = (tier: Tier): string[] =>
  tierServerLibraries({ tier, libraries: LIBRARIES })[SHARE_SERVER] ?? []

/** Every library name a tier grants, across all of its servers, sorted. */
const allNames = (tier: Tier): string[] =>
  Object.values(tierServerLibraries({ tier, libraries: LIBRARIES }))
    .flat()
    .toSorted()

/** Every server the snapshot names. */
const fleet = (): ReadonlySet<string> => new Set(LIBRARIES.map((lib) => lib.server_name))

describe('the recorded library snapshot', () => {
  it('still looks like a real wizarr response', () => {
    expect(LIBRARIES.length).toBeGreaterThan(20)
    const raw = isRecord(SNAPSHOT) && Array.isArray(SNAPSHOT.libraries) ? SNAPSHOT.libraries : []
    expect(
      raw.every(
        (lib) =>
          isRecord(lib) &&
          ['id', 'name', 'server_id', 'server_name', 'enabled'].every((key) => key in lib),
      ),
    ).toBe(true)
    // more than one server, or the share-server filter is not being exercised
    expect(fleet().size).toBeGreaterThan(1)
  })

  it.each(TIERS)('every tier resolves to something (%s)', (tier) => {
    // A tier resolving to nothing makes its checkouts raise and retry forever.
    expect(scope(tier).library_ids.length, `${tier} grants no libraries`).toBeGreaterThan(0)
  })

  it.each(TIERS)('no tier reaches a retired server (%s)', (tier) => {
    // Caraxes is retired outright: no tier may resolve a library there, and
    // the real snapshot still carries its libraries to prove the filter runs.
    expect(fleet().has('Caraxes')).toBe(true)
    expect(
      scope(tier).server_names.some((server) => RETIRED_SERVERS.has(server)),
      tier,
    ).toBe(false)
  })

  it.each(ENTRY_TIERS)('every entry tier stays on the share server (%s)', (tier) => {
    expect(scope(tier).server_names).toEqual([SHARE_SERVER])
  })

  it('gold spans every server except the retired ones', () => {
    // Gold is a denylist: every server the snapshot names, minus RETIRED_SERVERS.
    // A new NAS therefore joins gold's scope with no code change, which is the
    // whole point of deriving the set instead of declaring it.
    const servers = [...fleet()]
    expect(new Set(scope('gold').server_names)).toEqual(
      new Set(servers.filter((server) => !RETIRED_SERVERS.has(server))),
    )
    expect(
      servers.filter((server) => RETIRED_SERVERS.has(server)),
      'snapshot must still carry a retired server',
    ).toHaveLength(1)
  })

  it('a new fleet server lands in gold and nowhere else', () => {
    // The regression the hardcoded fleet set used to allow: a NAS added to
    // Wizarr stayed out of gold until someone remembered to edit the constant.
    const added: WizarrLibrary[] = [
      ...LIBRARIES,
      { id: 9001, name: '01. Movies', server_id: 99, server_name: 'Dreamfyre', enabled: true },
    ]
    const gold = resolveTierAccess({ tier: 'gold', libraries: added })
    expect(gold.server_names).toContain('Dreamfyre')
    expect(gold.library_ids).toContain(9001)
    ENTRY_TIERS.forEach((tier) => {
      expect(resolveTierAccess({ tier, libraries: added }).server_names, tier).toEqual([
        SHARE_SERVER,
      ])
    })
  })

  it('a retired server stays out of gold however the fleet grows', () => {
    const [retired = ''] = RETIRED_SERVERS
    const added: WizarrLibrary[] = [
      ...LIBRARIES,
      { id: 9002, name: '01. Movies', server_id: 98, server_name: retired, enabled: true },
    ]
    expect(resolveTierAccess({ tier: 'gold', libraries: added }).library_ids).not.toContain(9002)
  })

  it.each(TIERS)('no tier grants a private library (%s)', (tier) => {
    expect(names(tier).filter((name) => PRIVATE_NAME_RE.test(name))).toEqual([])
  })

  it.each(TIERS)('no tier grants a disabled library (%s)', (tier) => {
    const disabled = new Set(LIBRARIES.filter((lib) => !lib.enabled).map((lib) => lib.id))
    expect(scope(tier).library_ids.some((id) => disabled.has(id))).toBe(false)
  })

  it('the live scope check is happy with the snapshot', () => {
    // The same function the running bridge alerts on, against real names.
    expect(tierScopeProblems({ libraries: LIBRARIES })).toEqual({})
  })

  it('bronze is everything except 4k', () => {
    const everything = names('silver')
    expect(new Set(names('bronze'))).toEqual(
      new Set(everything.filter((name) => !name.toLowerCase().includes('4k'))),
    )
    expect(names('bronze').filter((name) => name.toLowerCase().includes('4k'))).toEqual([])
    expect(scope('bronze').allow_downloads).toBe(false)
  })

  it('silver grants every shareable library on the share server', () => {
    const shareable = LIBRARIES.filter(
      (lib) => lib.enabled && lib.server_name === SHARE_SERVER && !PRIVATE_NAME_RE.test(lib.name),
    )
      .map((lib) => lib.name)
      .toSorted()
    expect(names('silver')).toEqual(shareable)
    // gold still grants all of them here
    expect(names('gold')).toEqual(shareable)
  })

  it('gold grants every shareable library across its servers', () => {
    const shareable = LIBRARIES.filter(
      (lib) =>
        lib.enabled && !RETIRED_SERVERS.has(lib.server_name) && !PRIVATE_NAME_RE.test(lib.name),
    )
      .map((lib) => lib.name)
      .toSorted()
    expect(allNames('gold')).toEqual(shareable)
    expect(shareable.length, 'gold must reach past the share server').toBeGreaterThan(
      names('gold').length,
    )
  })

  it('only gold and youth allow downloads', () => {
    expect(scope('gold').allow_downloads).toBe(true)
    expect(scope('youth').allow_downloads).toBe(true)
    expect(scope('silver').allow_downloads).toBe(false)
    expect(scope('bronze').allow_downloads).toBe(false)
  })

  it('youth matches its allowlist exactly', () => {
    const titles = new Set(names('youth').map((name) => name.replace(LIBRARY_PREFIX_RE, '')))
    expect(titles).toEqual(new Set(YOUTH_LIBRARY_TITLES))
  })

  it('bronze grants strictly less than silver', () => {
    const silver = new Set(names('silver'))
    const bronze = names('bronze')
    expect(bronze.every((name) => silver.has(name))).toBe(true)
    expect(bronze.length).toBeLessThan(silver.size)
  })
})
