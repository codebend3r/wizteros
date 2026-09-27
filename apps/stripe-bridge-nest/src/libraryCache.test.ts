// Wizarr's library cache checked against what Plex actually calls each section.
//
// Wizarr shares by library NAME: at redemption it hands plexapi the names its
// `library` table holds for the invite, and plexapi looks each one up on the
// live server. Wizarr only refreshes that table when someone presses "scan
// libraries", so a rename on the Plex side leaves a stale name in the cache,
// and every invite carrying it is rejected whole ("Plex invitation failed",
// KeyError on the old title). That is how a bronze signup on 2026-09-04 landed
// with no access: "33. Formula 1" had become "22. Formula 1" on Meleys.
//
// plex.tv reports each server's sections with the same id Wizarr stores as
// `external_id`, so the bridge can spot the drift itself.

import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RETIRED_SERVERS,
  libraryCacheProblems,
  resolveTierAccess,
  staleLibraries,
  withoutStale,
} from '@/tiers.js'
import type { LiveSections, WizarrLibrary } from '@/types.js'

const CACHE: readonly WizarrLibrary[] = [
  {
    id: 58,
    external_id: '145283096',
    name: '33. Formula 1',
    server_id: 2,
    server_name: 'Meleys',
    enabled: true,
  },
  {
    id: 23,
    external_id: '137390246',
    name: '04. Movies',
    server_id: 2,
    server_name: 'Meleys',
    enabled: true,
  },
  // Gone from Plex but disabled: no tier grants it, so nothing can be rejected.
  {
    id: 14,
    external_id: '138663380',
    name: '05. Formula 1',
    server_id: 5,
    server_name: 'Syrax',
    enabled: false,
  },
  {
    id: 9,
    external_id: '999',
    name: '01. Classic TV Shows',
    server_id: 5,
    server_name: 'Syrax',
    enabled: true,
  },
]

const LIVE_MELEYS: Readonly<Record<string, string>> = {
  '145283096': '22. Formula 1',
  '137390246': '04. Movies',
  // new on Plex, not yet in the cache
  '145789065': '24. Basketball',
}

const LIVE_SYRAX: Readonly<Record<string, string>> = { '999': '01. Classic TV Shows' }

const LIVE: LiveSections = { Meleys: LIVE_MELEYS, Syrax: LIVE_SYRAX }

/** LIVE with the Meleys "04. Movies" section gone. */
const withoutMovies = (): LiveSections => ({
  ...LIVE,
  Meleys: Object.fromEntries(Object.entries(LIVE_MELEYS).filter(([k]) => k !== '137390246')),
})

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

describe('staleLibraries', () => {
  it('a renamed library is stale', () => {
    const stale = staleLibraries({ libraries: CACHE, live: LIVE })
    expect(stale.map((row) => [row.id, row.name, row.live_name])).toEqual([
      [58, '33. Formula 1', '22. Formula 1'],
    ])
  })

  it('a library gone from plex is stale', () => {
    const stale = staleLibraries({ libraries: CACHE, live: withoutMovies() })
    expect(new Set(stale.map((row) => row.id))).toEqual(new Set([58, 23]))
    expect(stale.find((row) => row.id === 23)).toMatchObject({ live_name: null })
  })

  it('a disabled row is never stale', () => {
    const ids = staleLibraries({ libraries: CACHE, live: LIVE }).map((row) => row.id)
    expect(ids).not.toContain(14)
  })

  it('a row on a retired server is never stale', () => {
    // No tier shares from Caraxes, so its rows can never reach an invite and
    // a drifted Caraxes cache is not worth an hourly alarm.
    const [retired = ''] = RETIRED_SERVERS
    const rows: WizarrLibrary[] = [
      ...CACHE,
      {
        id: 30,
        external_id: '137934871',
        name: '01. UFC',
        server_id: 4,
        server_name: retired,
        enabled: true,
      },
    ]
    const live: LiveSections = { ...LIVE, [retired]: {} }
    expect(staleLibraries({ libraries: rows, live }).map((row) => row.id)).not.toContain(30)
    expect(libraryCacheProblems({ libraries: rows, live })).not.toHaveProperty([
      `wizarr cache on ${retired}`,
    ])
  })

  it('a server plex.tv does not list is skipped', () => {
    // Nothing can be checked against a server plex.tv does not report, and an
    // unknown server is not a stale cache.
    const live: LiveSections = { Syrax: LIVE_SYRAX }
    expect(staleLibraries({ libraries: CACHE, live })).toEqual([])
  })

  it('a row without an external id is skipped', () => {
    const rows = CACHE.map(({ external_id: _dropped, ...row }) => row)
    expect(staleLibraries({ libraries: rows, live: LIVE })).toEqual([])
  })

  it('no live view means nothing is stale', () => {
    // plex.tv down is not drift: the cache is trusted as-is rather than
    // blocking every checkout on a third party.
    expect(staleLibraries({ libraries: CACHE, live: null })).toEqual([])
    expect(withoutStale({ libraries: CACHE, live: null })).toEqual(CACHE)
  })
})

describe('withoutStale', () => {
  it('drops exactly the stale rows in order', () => {
    captureErrors()
    const kept = withoutStale({ libraries: CACHE, live: LIVE })
    expect(kept.map((row) => row.id)).toEqual([23, 14, 9])
  })

  it('a tier scope never carries a stale library', () => {
    // The invite still grants everything Plex will accept, rather than
    // nothing, and the scope check alerts on the dropped one.
    captureErrors()
    const scope = resolveTierAccess({
      tier: 'bronze',
      libraries: withoutStale({ libraries: CACHE, live: LIVE }),
    })
    expect(scope.library_ids).toEqual([23])
  })

  it('dropping a stale row is logged with the remedy', () => {
    const errorLogs = captureErrors()
    withoutStale({ libraries: CACHE, live: LIVE })
    expect(errorLogs()).toContain('33. Formula 1')
    expect(errorLogs()).toContain('22. Formula 1')
    expect(errorLogs().toLowerCase()).toContain('rescan')
    expect(errorLogs()).toBe(
      "dropping stale library '33. Formula 1' on Meleys from the invite scope: " +
        "Plex now calls it '22. Formula 1'; rescan the server's libraries in Wizarr to " +
        'restore it',
    )
  })
})

describe('libraryCacheProblems', () => {
  it('cache problems are keyed by server and read like a remedy', () => {
    const problems = libraryCacheProblems({ libraries: CACHE, live: LIVE })
    expect(Object.keys(problems)).toEqual(['wizarr cache on Meleys'])
    const reason = problems['wizarr cache on Meleys'] ?? ''
    expect(reason).toContain("'33. Formula 1' is now '22. Formula 1'")
    expect(reason.toLowerCase()).toContain('rescan')
  })

  it('cache problems name a library that vanished', () => {
    const problems = libraryCacheProblems({ libraries: CACHE, live: withoutMovies() })
    expect(problems['wizarr cache on Meleys'] ?? '').toContain("'04. Movies' is gone")
  })

  it('a healthy cache has no problems', () => {
    const healthy = CACHE.map((row) =>
      row.id === 58 ? Object.assign({}, row, { name: '22. Formula 1' }) : row,
    )
    expect(libraryCacheProblems({ libraries: healthy, live: LIVE })).toEqual({})
    expect(libraryCacheProblems({ libraries: healthy, live: null })).toEqual({})
  })
})
