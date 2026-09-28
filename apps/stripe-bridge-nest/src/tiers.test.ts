import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TIER_DOWNLOADS,
  canonicalTier,
  isPrivate,
  normalizeTier,
  resolveTierAccess,
  staleRecordIds,
  tierServerLibraries,
} from '@/tiers.js'
import type { WizarrLibrary } from '@/types.js'

// Meleys carries every library the paid-entry tiers grant. Gold reaches wider:
// it spans the whole fleet except Caraxes, which is retired outright and may
// never be shared with anyone again.
const LIBRARIES: readonly WizarrLibrary[] = [
  { id: 23, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 24, name: '02. 4K Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 25, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 26, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 27, name: '05. TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 28, name: '06. 4K TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 29, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 50, name: '07. Disabled Stuff', server_id: 2, server_name: 'Meleys', enabled: false },
  { id: 61, name: '95. Private Stuff', server_id: 2, server_name: 'Meleys', enabled: true },
  // Retired servers below — enabled and non-private, but off-limits anyway.
  {
    id: 9,
    name: '01. Classic TV Shows (switch to Meleys)',
    server_id: 5,
    server_name: 'Syrax',
    enabled: true,
  },
  {
    id: 17,
    name: '01. TV Shows (switch to Meleys)',
    server_id: 1,
    server_name: 'Vermithor',
    enabled: true,
  },
  {
    id: 22,
    name: '06. Kid Shows (switch to Meleys)',
    server_id: 1,
    server_name: 'Vermithor',
    enabled: true,
  },
  {
    id: 30,
    name: '01. UFC (switch to Meleys)',
    server_id: 4,
    server_name: 'Caraxes',
    enabled: true,
  },
  { id: 36, name: '09. Basketball', server_id: 4, server_name: 'Caraxes', enabled: true },
  { id: 37, name: '99. Tutorials', server_id: 4, server_name: 'Caraxes', enabled: true },
  {
    id: 40,
    name: '01. 4K Movies (switch to Meleys)',
    server_id: 3,
    server_name: 'Vhagar',
    enabled: true,
  },
]

const CARAXES_IDS: ReadonlySet<number> = new Set([30, 36, 37])
// Enabled, non-private, off Meleys: gold's reach, and nobody else's.
const FLEET_IDS: ReadonlySet<number> = new Set([9, 17, 22, 40])
const PRIVATE_IDS: ReadonlySet<number> = new Set([37, 61])
const FOUR_K_IDS: ReadonlySet<number> = new Set([24, 26, 28])
const ENTRY_TIERS = ['bronze', 'silver', 'youth'] as const
const TIERS = [...TIER_DOWNLOADS.keys()]

/** Whether two id collections share no member. */
const disjoint = ({ a, b }: { a: ReadonlySet<number>; b: readonly number[] }): boolean =>
  !b.some((id) => a.has(id))

/**
 * Silence and capture the bridge logger's error level, standing in for caplog.
 * Returns a reader for every message logged since, one per line.
 */
const captureErrors = (): (() => string) => {
  const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  return () => spy.mock.calls.map((call) => String(call[0])).join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tier scopes', () => {
  it('caraxes is shared with no tier', () => {
    // Retired outright. Not narrowed, not mirrored: gone.
    TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES })
      expect(disjoint({ a: CARAXES_IDS, b: out.library_ids }), tier).toBe(true)
      expect(out.server_names, tier).not.toContain('Caraxes')
    })
  })

  it('only gold reaches past the share server', () => {
    ENTRY_TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES })
      expect(disjoint({ a: FLEET_IDS, b: out.library_ids }), tier).toBe(true)
      expect(out.server_names, tier).toEqual(['Meleys'])
    })
    const gold = resolveTierAccess({ tier: 'gold', libraries: LIBRARIES })
    expect([...FLEET_IDS].every((id) => gold.library_ids.includes(id))).toBe(true)
    expect(gold.server_names).toEqual(['Meleys', 'Syrax', 'Vermithor', 'Vhagar'])
  })

  it('gold grants every enabled public library on its servers', () => {
    const gold = new Set(resolveTierAccess({ tier: 'gold', libraries: LIBRARIES }).library_ids)
    const expected = new Set(
      LIBRARIES.filter(
        (lib) =>
          !!lib.enabled &&
          ['Meleys', 'Syrax', 'Vermithor', 'Vhagar'].includes(lib.server_name ?? '') &&
          !PRIVATE_IDS.has(lib.id),
      ).map((lib) => lib.id),
    )
    expect(gold).toEqual(expected)
  })

  it('server guards survive tier rule bugs', () => {
    // Simulate a future tier-rule bug that wants every library shared. Caraxes
    // must stay unreachable for every tier, and the entry tiers must stay on
    // the share server.
    const wants = (): boolean => true
    TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES, wants })
      expect(disjoint({ a: CARAXES_IDS, b: out.library_ids }), tier).toBe(true)
    })
    ENTRY_TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES, wants })
      expect(disjoint({ a: FLEET_IDS, b: out.library_ids }), tier).toBe(true)
    })
  })

  it('a library with no server name is never shared', () => {
    const orphan: WizarrLibrary[] = [
      { id: 999, name: '01. Orphan', server_id: 9, server_name: null, enabled: true },
    ]
    TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: [...LIBRARIES, ...orphan] })
      expect(out.library_ids, tier).not.toContain(999)
    })
  })

  it('private libraries appear in no tier', () => {
    TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES })
      expect(disjoint({ a: PRIVATE_IDS, b: out.library_ids }), tier).toBe(true)
    })
  })

  it('private guard survives tier rule bugs', () => {
    const wants = (): boolean => true
    TIERS.forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES, wants })
      expect(disjoint({ a: PRIVATE_IDS, b: out.library_ids }), tier).toBe(true)
    })
  })

  it('bronze excludes 4k and disallows downloads', () => {
    const out = resolveTierAccess({ tier: 'bronze', libraries: LIBRARIES })
    expect(out.library_ids).toEqual([23, 25, 27, 29])
    expect(out.server_ids).toEqual([2])
    expect(out.allow_downloads).toBe(false)
  })

  it('silver includes 4k without downloads', () => {
    const out = resolveTierAccess({ tier: 'silver', libraries: LIBRARIES })
    expect([...FOUR_K_IDS].every((id) => out.library_ids.includes(id))).toBe(true)
    expect(out.library_ids).toEqual([23, 24, 25, 26, 27, 28, 29])
    expect(out.allow_downloads).toBe(false)
  })

  it('gold is silver plus the rest of the fleet', () => {
    // Gold used to match silver exactly; it now adds the fleet servers.
    const silver = resolveTierAccess({ tier: 'silver', libraries: LIBRARIES })
    const gold = resolveTierAccess({ tier: 'gold', libraries: LIBRARIES })
    const silverIds = new Set(silver.library_ids)
    expect(silver.library_ids.every((id) => gold.library_ids.includes(id))).toBe(true)
    expect(gold.library_ids.length).toBeGreaterThan(silver.library_ids.length)
    expect(new Set(gold.library_ids.filter((id) => !silverIds.has(id)))).toEqual(FLEET_IDS)
    expect(silver.server_ids.every((id) => gold.server_ids.includes(id))).toBe(true)
    expect(gold.server_ids.length).toBeGreaterThan(silver.server_ids.length)
    expect(gold.allow_downloads).toBe(true)
  })

  it('youth gets exactly the allowlist', () => {
    const out = resolveTierAccess({ tier: 'youth', libraries: LIBRARIES })
    expect(out.library_ids).toEqual([25, 26, 29])
    expect(out.server_ids).toEqual([2])
    expect(out.allow_downloads).toBe(true)
  })

  it("youth ignores the retired servers' mirror", () => {
    // Vermithor still carries a "06. Kid Shows (switch to Meleys)" mirror; the
    // allowlist must resolve to the Meleys copy alone.
    const out = resolveTierAccess({ tier: 'youth', libraries: LIBRARIES })
    expect(out.library_ids).not.toContain(22)
    expect(out.library_ids).toContain(29)
  })

  it('youth allowlist miss logs and proceeds', () => {
    // "14. Kid Shows" renamed on the server -> log loudly, share what matched.
    const errorLogs = captureErrors()
    const renamed = LIBRARIES.filter((lib) => lib.id !== 29)
    const out = resolveTierAccess({ tier: 'youth', libraries: renamed })
    expect(out.library_ids).toEqual([25, 26])
    expect(errorLogs()).toContain('youth allowlist')
    expect(errorLogs()).toContain('youth allowlist mismatch on Meleys; missing Kid Shows')
  })

  it('youth never resolves to an empty scope', () => {
    // An empty youth scope makes every youth checkout raise "no libraries
    // resolved" and retry forever, so no invite is ever delivered.
    const errorLogs = captureErrors()
    const out = resolveTierAccess({ tier: 'youth', libraries: LIBRARIES })
    expect(out.library_ids.length).toBeGreaterThan(0)
    expect(errorLogs()).not.toContain('youth allowlist')
  })

  it('09 prefix is not private', () => {
    // "09. Basketball" starts with "09.", not "9X." -- the private rule leaves
    // it alone; the share-server filter is what keeps it out of every tier.
    expect(isPrivate({ name: '09. Basketball' })).toBe(false)
  })

  it('private rule is name only', () => {
    // The 9X. guard keys off the name alone, so it fails closed even for a
    // library sitting on the share server itself.
    const out = resolveTierAccess({ tier: 'silver', libraries: LIBRARIES })
    expect(out.library_ids).not.toContain(61)
  })

  it('disabled libraries are never shared', () => {
    ;['bronze', 'silver', 'gold'].forEach((tier) => {
      const out = resolveTierAccess({ tier, libraries: LIBRARIES })
      expect(out.library_ids, tier).not.toContain(50)
    })
  })
})

describe('tierServerLibraries', () => {
  it('groups gold across the fleet', () => {
    const out = tierServerLibraries({ tier: 'gold', libraries: LIBRARIES })
    expect(out).toEqual({
      Meleys: [
        '01. Movies',
        '02. 4K Movies',
        '03. Family Movies',
        '04. 4K Family Movies',
        '05. TV Shows',
        '06. 4K TV Shows',
        '14. Kid Shows',
      ],
      Syrax: ['01. Classic TV Shows (switch to Meleys)'],
      Vermithor: ['01. TV Shows (switch to Meleys)', '06. Kid Shows (switch to Meleys)'],
      Vhagar: ['01. 4K Movies (switch to Meleys)'],
    })
  })

  it('keeps the entry tiers on one server', () => {
    ENTRY_TIERS.forEach((tier) => {
      const out = tierServerLibraries({ tier, libraries: LIBRARIES })
      expect(Object.keys(out), tier).toEqual(['Meleys'])
    })
  })

  it('bronze drops 4k', () => {
    const out = tierServerLibraries({ tier: 'bronze', libraries: LIBRARIES })
    expect(out).toEqual({
      Meleys: ['01. Movies', '03. Family Movies', '05. TV Shows', '14. Kid Shows'],
    })
  })

  it('youth matches allowlist', () => {
    const out = tierServerLibraries({ tier: 'youth', libraries: LIBRARIES })
    expect(out).toEqual({
      Meleys: ['03. Family Movies', '04. 4K Family Movies', '14. Kid Shows'],
    })
  })

  it('never lists caraxes', () => {
    TIERS.forEach((tier) => {
      const out = tierServerLibraries({ tier, libraries: LIBRARIES })
      expect(Object.keys(out), tier).not.toContain('Caraxes')
    })
  })

  it('never includes private or disabled', () => {
    TIERS.forEach((tier) => {
      const out = tierServerLibraries({ tier, libraries: LIBRARIES })
      const names = Object.values(out).flat()
      expect(names, tier).not.toContain('07. Disabled Stuff')
      expect(
        names.some((name) => name.startsWith('9')),
        tier,
      ).toBe(false)
    })
  })

  it('unknown tier grants nothing', () => {
    expect(tierServerLibraries({ tier: 'unknown', libraries: LIBRARIES })).toEqual({})
  })
})

describe('staleRecordIds', () => {
  it('returns every record off the share server', () => {
    // Legacy members hold records on the retired servers. A Meleys-only scope
    // covers none of them and Wizarr has no per-server unshare, so the whole
    // set is disabled and the member re-joins through the invite.
    const records = [
      { id: 1, server: 'Meleys' },
      { id: 2, server: 'Vermithor' },
      { id: 3, server: 'Vhagar' },
    ]
    expect(staleRecordIds({ records, coveredServers: ['Meleys'] })).toEqual([1, 2, 3])
  })

  it('is empty when every record is covered', () => {
    const records = [{ id: 1, server: 'Meleys' }]
    expect(staleRecordIds({ records, coveredServers: ['Meleys'] })).toEqual([])
  })

  it('fails closed on a missing server name', () => {
    const records = [
      { id: 1, server: 'Meleys' },
      { id: 2, server: null },
    ]
    expect(staleRecordIds({ records, coveredServers: ['Meleys'] })).toEqual([1, 2])
  })
})

describe('normalizeTier', () => {
  it('accepts known tiers case-insensitively', () => {
    expect(normalizeTier('gold')).toBe('gold')
    expect(normalizeTier(' Silver ')).toBe('silver')
    expect(normalizeTier('YOUTH')).toBe('youth')
  })

  it('maps legacy kids to youth', () => {
    // Pre-rebrand Stripe metadata and stored rows still say "kids".
    expect(normalizeTier('kids')).toBe('youth')
    expect(normalizeTier('KIDS')).toBe('youth')
    expect(canonicalTier('kids')).toBe('youth')
    expect(canonicalTier(null)).toBeNull()
  })

  it('defaults unknown and missing to bronze', () => {
    const errorLogs = captureErrors()
    expect(normalizeTier('platinum')).toBe('bronze')
    expect(normalizeTier(null)).toBe('bronze')
    expect(normalizeTier('')).toBe('bronze')
    expect(normalizeTier(123)).toBe('bronze')
    expect(errorLogs()).toContain('unknown tier')
    expect(errorLogs()).toContain(
      'unknown tier "platinum" on checkout session; defaulting to bronze',
    )
    expect(errorLogs()).toContain('unknown tier null on checkout session')
    expect(errorLogs()).toContain('unknown tier 123 on checkout session')
  })
})
