import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TIERS,
  canonicalTier,
  isPrivate,
  normalizeTier,
  resolveTierAccess,
  staleRecordIds,
  tierServerLibraries,
} from '@/tiers.js'
import type { WizarrLibrary } from '@/types.js'

// Exercise the same library rules on every server, including the retired one.
const SERVERS = ['Meleys', 'Vermithor', 'Vhagar', 'Syrax', 'Caraxes']
const NAMES = [
  'Movies',
  '4K Movies',
  'Family Movies',
  '4K Family Movies',
  'Kid Shows',
  '95. Private',
  'Disabled',
]
const LIBRARIES: readonly WizarrLibrary[] = SERVERS.flatMap((server, index) =>
  NAMES.map((name, offset) => ({
    id: index * 10 + offset,
    name,
    server_id: index + 1,
    server_name: server,
    enabled: name !== 'Disabled',
  })),
)

const captureErrors = (): (() => string) => {
  const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  return () => spy.mock.calls.map((call) => String(call[0])).join('\n')
}

afterEach(() => vi.restoreAllMocks())

describe('tier scopes', () => {
  it.each(TIERS)('%s applies its library rule across all four servers', (tier) => {
    const out = resolveTierAccess({ tier, libraries: LIBRARIES })
    const offsets = tier === 'bronze' ? [0, 2, 4] : tier === 'youth' ? [2, 3, 4] : [0, 1, 2, 3, 4]
    expect(out.library_ids).toEqual(
      [0, 1, 2, 3].flatMap((index) => offsets.map((offset) => index * 10 + offset)),
    )
    expect(out.server_names).toEqual(['Meleys', 'Syrax', 'Vermithor', 'Vhagar'])
    expect(out.server_ids).toEqual([1, 2, 3, 4])
    expect(out.allow_downloads).toBe(tier === 'gold' || tier === 'youth')
  })

  it.each(TIERS)(
    '%s cannot share Caraxes, private, disabled or unnamed-server libraries even with a broken rule',
    (tier) => {
      const libraries = [
        ...LIBRARIES,
        { id: 999, name: 'Movies', server_id: 9, server_name: null, enabled: true },
        { id: 998, name: 'Movies', server_id: 9, enabled: true },
        { id: 997, name: 'Movies', server_id: 9, server_name: '', enabled: true },
      ]
      const out = resolveTierAccess({ tier, libraries, wants: () => true })
      expect(out.library_ids).toEqual(
        [0, 1, 2, 3].flatMap((index) => [0, 1, 2, 3, 4].map((offset) => index * 10 + offset)),
      )
    },
  )

  it.each([
    ['4K Movies', false],
    ['4K Family Movies', false],
    ['01. 4K Movies', false],
    ['Movies in 4K', true],
    ['Movies (4K)', true],
    ['Movies', true],
  ])('bronze uses the 4K title prefix for %s', (name, included) => {
    const libraries = [{ id: 1, name, server_id: 2, server_name: 'Meleys', enabled: true }]
    expect(resolveTierAccess({ tier: 'bronze', libraries }).library_ids.includes(1)).toBe(included)
  })

  it('youth still matches legacy numbered titles', () => {
    const libraries = LIBRARIES.map((lib) => ({ ...lib, name: `01. ${lib.name}` }))
    const out = resolveTierAccess({ tier: 'youth', libraries })
    expect(out.library_ids).toEqual([2, 3, 4, 12, 13, 14, 22, 23, 24, 32, 33, 34])
  })

  it('youth accepts matching libraries anywhere in the fleet', () => {
    const libraries = LIBRARIES.filter((lib) => lib.server_name !== 'Meleys')
    const out = resolveTierAccess({ tier: 'youth', libraries })
    expect(out.library_ids).toEqual([12, 13, 14, 22, 23, 24, 32, 33, 34])
  })

  it('youth logs a missing title across the fleet and grants the remaining matches', () => {
    const errors = captureErrors()
    const libraries = LIBRARIES.filter((lib) => lib.name !== 'Kid Shows')
    const out = resolveTierAccess({ tier: 'youth', libraries })
    expect(out.library_ids).toEqual([2, 3, 12, 13, 22, 23, 32, 33])
    expect(errors()).toContain('youth allowlist mismatch across the fleet; missing Kid Shows')
  })

  it('09 is not a private prefix, but 9X is', () => {
    expect(isPrivate({ name: '09. Basketball' })).toBe(false)
    expect(isPrivate({ name: '95. Private' })).toBe(true)
  })
})

describe('tierServerLibraries', () => {
  it.each(TIERS)('groups %s libraries on every eligible server', (tier) => {
    const grouped = tierServerLibraries({ tier, libraries: LIBRARIES })
    expect(Object.keys(grouped)).toEqual(SERVERS.filter((server) => server !== 'Caraxes'))
    const expected =
      tier === 'bronze'
        ? ['Family Movies', 'Kid Shows', 'Movies']
        : tier === 'youth'
          ? ['4K Family Movies', 'Family Movies', 'Kid Shows']
          : ['4K Family Movies', '4K Movies', 'Family Movies', 'Kid Shows', 'Movies']
    Object.values(grouped).forEach((names) => expect(names).toEqual(expected))
  })
})

describe('staleRecordIds', () => {
  it('disables every record if any server is outside the resolved scope', () => {
    const records = [
      { id: 1, server: 'Meleys' },
      { id: 2, server: 'Caraxes' },
    ]
    expect(
      staleRecordIds({ records, coveredServers: SERVERS.filter((server) => server !== 'Caraxes') }),
    ).toEqual([1, 2])
  })

  it('keeps records when every server is covered', () => {
    const records = [
      { id: 1, server: 'Meleys' },
      { id: 2, server: 'Vermithor' },
    ]
    expect(staleRecordIds({ records, coveredServers: ['Meleys', 'Vermithor'] })).toEqual([])
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
    expect(normalizeTier('kids')).toBe('youth')
    expect(normalizeTier('KIDS')).toBe('youth')
    expect(canonicalTier('kids')).toBe('youth')
    expect(canonicalTier(null)).toBeNull()
  })

  it('defaults unknown and missing to bronze', () => {
    const errors = captureErrors()
    expect(normalizeTier('platinum')).toBe('bronze')
    expect(normalizeTier(null)).toBe('bronze')
    expect(normalizeTier('')).toBe('bronze')
    expect(normalizeTier(123)).toBe('bronze')
    expect(errors()).toContain('unknown tier "platinum" on checkout session; defaulting to bronze')
    expect(errors()).toContain('unknown tier null on checkout session')
    expect(errors()).toContain('unknown tier 123 on checkout session')
  })
})
