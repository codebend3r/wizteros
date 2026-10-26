// Recorded from Wizarr after refreshing the renamed Plex libraries.
// Refresh with `bun run refresh:libraries` after a Plex library rename.
import { describe, expect, it } from 'vitest'
import { isRecord } from '@wizteros/server-common'

import { fixtureJson } from '@/test/support.js'
import {
  PRIVATE_NAME_RE,
  RETIRED_SERVERS,
  type Tier,
  TIERS,
  resolveTierAccess,
  tierScopeProblems,
  tierServerLibraries,
} from '@/tiers.js'
import type { WizarrLibrary } from '@/types.js'

type SnapshotLibrary = WizarrLibrary &
  Readonly<{ name: string; server_name: string; enabled: boolean }>

const isSnapshotLibrary = (value: unknown): value is SnapshotLibrary =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.server_id === 'number' &&
  typeof value.server_name === 'string' &&
  typeof value.enabled === 'boolean'

const loadLibraries = (): readonly SnapshotLibrary[] => {
  const snapshot = fixtureJson('live-libraries.json')
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.libraries) ||
    !snapshot.libraries.every(isSnapshotLibrary)
  ) {
    throw new Error('live-libraries.json is not a Wizarr library list')
  }
  return snapshot.libraries
}

const LIBRARIES = loadLibraries()
const scope = (tier: Tier) => resolveTierAccess({ tier, libraries: LIBRARIES })
const shareable = LIBRARIES.filter(
  (lib) => lib.enabled && !RETIRED_SERVERS.has(lib.server_name) && !PRIVATE_NAME_RE.test(lib.name),
)

const expected = (tier: Tier): readonly SnapshotLibrary[] =>
  shareable.filter((lib) => {
    if (tier === 'bronze') return !lib.name.startsWith('4K')
    if (tier === 'youth')
      return ['Family Movies', '4K Family Movies', 'Kid Shows'].includes(lib.name)
    return true
  })

describe('the recorded library snapshot', () => {
  it('contains all five servers, including excluded Caraxes', () => {
    expect(LIBRARIES.length).toBeGreaterThan(20)
    expect(new Set(LIBRARIES.map((lib) => lib.server_name))).toEqual(
      new Set(['Meleys', 'Vermithor', 'Vhagar', 'Syrax', 'Caraxes']),
    )
  })

  it('enabled public libraries use the new unnumbered names', () => {
    expect(shareable.every((lib) => !/^\d+\./.test(lib.name))).toBe(true)
  })

  it.each(TIERS)('%s grants exactly its eligible fleet libraries', (tier) => {
    const out = scope(tier)
    const libraries = expected(tier)
    expect(out.library_ids.length).toBeGreaterThan(0)
    expect(out.library_ids).toEqual(libraries.map((lib) => lib.id))
    expect(new Set(out.server_names)).toEqual(new Set(libraries.map((lib) => lib.server_name)))
    expect(new Set(out.server_ids)).toEqual(new Set(libraries.map((lib) => lib.server_id)))
    expect(out.server_names).not.toContain('Caraxes')
    expect(out.allow_downloads).toBe(tier === 'gold' || tier === 'youth')
  })

  it.each<Tier>(['silver', 'gold'])('%s includes all four servers', (tier) => {
    expect(scope(tier).server_names).toEqual(['Meleys', 'Syrax', 'Vermithor', 'Vhagar'])
    expect(scope(tier).library_ids).toHaveLength(33)
  })

  it('bronze cannot access Vhagar because its only enabled library is 4K', () => {
    expect(scope('bronze').server_names).toEqual(['Meleys', 'Syrax', 'Vermithor'])
    expect(scope('bronze').library_ids).toHaveLength(28)
  })

  it('youth includes the family library on Vermithor as well as Meleys', () => {
    expect(scope('youth').server_names).toEqual(['Meleys', 'Vermithor'])
    expect(new Set(scope('youth').library_ids)).toEqual(new Set([20, 24, 42, 50]))
  })

  it('the admin breakdown lists the same libraries as signup', () => {
    TIERS.forEach((tier) => {
      const grouped = tierServerLibraries({ tier, libraries: LIBRARIES })
      expect(grouped).toEqual(
        Object.fromEntries(
          [...new Set(expected(tier).map((lib) => lib.server_name))].map((server) => [
            server,
            expected(tier)
              .filter((lib) => lib.server_name === server)
              .map((lib) => lib.name)
              .toSorted(),
          ]),
        ),
      )
    })
  })

  it('the live scope check is healthy', () => {
    expect(tierScopeProblems({ libraries: LIBRARIES })).toEqual({})
  })

  it.each(TIERS)('%s applies its rule when a new fleet server appears', (tier) => {
    const added = NAMES_FOR_NEW_SERVER.map((name, index) => ({
      id: 9000 + index,
      name,
      server_id: 99,
      server_name: 'Dreamfyre',
      enabled: true,
    }))
    const out = resolveTierAccess({ tier, libraries: [...LIBRARIES, ...added] })
    expect(out.server_names).toContain('Dreamfyre')
    expect(out.library_ids.filter((id) => id >= 9000)).toEqual(
      tier === 'bronze' ? [9000, 9002] : tier === 'youth' ? [9002] : [9000, 9001, 9002],
    )
  })
})

const NAMES_FOR_NEW_SERVER = ['Movies', '4K Movies', 'Kid Shows']
