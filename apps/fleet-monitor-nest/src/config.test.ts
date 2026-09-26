import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dbPath,
  host,
  HOSTS,
  MAX_ROUND_SECONDS,
  PLEX_HISTORY_INTERVAL,
  PLEX_LIBRARY_INTERVAL,
  plexExcludedPaths,
  plexHosts,
  plexLookbackDays,
  plexToken,
  SLOW_INTERVAL,
  SLOW_TIMEOUT,
  sshUser,
  VITALS_INTERVAL,
  VITALS_TIMEOUT,
} from '@/config.js'
import { CAPTURE_FACTOR } from '@/transport/ssh.js'

const names = (hosts: readonly { name: string }[]): string[] =>
  hosts.map(({ name }) => name).toSorted()

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('configures every fleet host', () => {
    expect(names(HOSTS)).toEqual(['caraxes', 'meleys', 'syrax', 'vermithor', 'vhagar'])
  })

  it('gives only vermithor and vhagar a render node', () => {
    // measured 2026-08-10: meleys is AMD, syrax is Atom, caraxes is ARM
    expect(names(HOSTS.filter(({ has_gpu }) => has_gpu))).toEqual(['vermithor', 'vhagar'])
  })

  it('configures the three docker hosts', () => {
    // vhagar joined on 2026-08-11 when Jellyfin was installed there; caraxes is
    // aarch64 and Synology's Container Manager is x86-only, so it never will
    expect(names(HOSTS.filter(({ docker_url }) => !!docker_url))).toEqual([
      'meleys',
      'vermithor',
      'vhagar',
    ])
  })

  it('matches the fleet ips', () => {
    const byName = Object.fromEntries(HOSTS.map(({ name, ip }) => [name, ip]))
    expect(byName).toEqual({
      meleys: '192.168.50.2',
      vermithor: '192.168.50.3',
      caraxes: '192.168.50.4',
      syrax: '192.168.50.5',
      vhagar: '192.168.50.6',
    })
  })

  it('freezes a host', () => {
    const ghost = host({ name: 'ghost', ip: '192.0.2.1', has_gpu: false, docker_url: '' })
    expect(Object.isFrozen(ghost)).toBe(true)
    expect(Object.isFrozen(HOSTS)).toBe(true)
  })

  it('defaults the db path and honors the environment', () => {
    vi.stubEnv('FM_DB_PATH', undefined)
    expect(dbPath()).toBe('/data/fleet.db')

    vi.stubEnv('FM_DB_PATH', '/tmp/other.db')
    expect(dbPath()).toBe('/tmp/other.db')
  })

  it('defaults the ssh user and honors the environment', () => {
    vi.stubEnv('FM_SSH_USER', undefined)
    expect(sshUser()).toBe('crivas')

    vi.stubEnv('FM_SSH_USER', 'someone')
    expect(sshUser()).toBe('someone')
  })

  it('makes the slow tier a whole multiple of the vitals tier', () => {
    // the loop counts vitals rounds to decide when the slow tier is due, so a
    // non-integer ratio would silently drift the 15 minute cadence
    expect(SLOW_INTERVAL % VITALS_INTERVAL).toBe(0)
  })

  it('derives the round budget from the transport that spends it', () => {
    // the coverage gap is derived from this, and a wrong tolerance silently
    // blanks every uptime score on a slow round
    expect(MAX_ROUND_SECONDS).toBe((VITALS_TIMEOUT + SLOW_TIMEOUT) * CAPTURE_FACTOR)
  })

  it('gives every host a plex url', () => {
    // Plex runs natively on all five boxes (measured 2026-09-18), so an empty
    // url here would silently drop a server from every play-history view
    expect(names(plexHosts())).toEqual(['caraxes', 'meleys', 'syrax', 'vermithor', 'vhagar'])
  })

  it('keeps plex hosts in config order', () => {
    expect(plexHosts().map(({ name }) => name)).toEqual(HOSTS.map(({ name }) => name))
  })

  it('addresses the two secure-only servers over https', () => {
    // vermithor and vhagar close a plain-http socket without a response
    // (measured 2026-09-18); the other three answer on http
    const byName = Object.fromEntries(HOSTS.map(({ name, plex_url }) => [name, plex_url]))
    expect(byName).toEqual({
      meleys: 'http://192.168.50.2:32400',
      vermithor: 'https://192.168.50.3:32400',
      caraxes: 'http://192.168.50.4:32400',
      syrax: 'http://192.168.50.5:32400',
      vhagar: 'https://192.168.50.6:32400',
    })
  })

  it('defaults a host to no plex', () => {
    const ghost = host({ name: 'ghost', ip: '192.0.2.1', has_gpu: false, docker_url: '' })
    expect(ghost.plex_url).toBe('')
  })

  it('prefers the monitor-prefixed plex token, then the shared name', () => {
    vi.stubEnv('FM_PLEX_TOKEN', undefined)
    vi.stubEnv('PLEX_TOKEN', undefined)
    expect(plexToken()).toBe('')

    // the bridge's token is in the same .env every compose service reads, so
    // the monitor works with no new variable at all
    vi.stubEnv('PLEX_TOKEN', 'shared')
    expect(plexToken()).toBe('shared')

    vi.stubEnv('FM_PLEX_TOKEN', 'own')
    expect(plexToken()).toBe('own')
  })

  it('defaults the lookback to a year and survives junk', () => {
    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', undefined)
    expect(plexLookbackDays()).toBe(365)

    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', '730')
    expect(plexLookbackDays()).toBe(730)

    // a typo must not turn into a zero-day backfill or a crash at boot
    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', 'a year')
    expect(plexLookbackDays()).toBe(365)

    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', '-3')
    expect(plexLookbackDays()).toBe(365)

    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', '2.5')
    expect(plexLookbackDays()).toBe(365)
  })

  it('makes the plex cadences whole seconds with the inventory the slow one', () => {
    expect(PLEX_HISTORY_INTERVAL).toBe(300)
    expect(PLEX_LIBRARY_INTERVAL).toBe(6 * 3600)
    expect(PLEX_LIBRARY_INTERVAL % PLEX_HISTORY_INTERVAL).toBe(0)
  })

  it('excludes the caraxes scratch tree by default', () => {
    // four movie libraries of tutorials, home videos, documents and
    // assignments (measured 2026-09-19); none of them is what the page counts
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', undefined)
    expect(plexExcludedPaths()).toEqual(['/volume1/Caraxes/tmp'])
  })

  it('lets the excluded paths be replaced or switched off', () => {
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', '/volume1/A/tmp, /volume1/B/scratch')
    expect(plexExcludedPaths()).toEqual(['/volume1/A/tmp', '/volume1/B/scratch'])

    // an empty value is "count everything", not "fall back to the default"
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', '')
    expect(plexExcludedPaths()).toEqual([])
  })
})
