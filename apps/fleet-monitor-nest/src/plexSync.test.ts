import { createServer, type IncomingMessage } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { host, PLEX_HISTORY_INTERVAL, plexHosts } from '@/config.js'
import { session } from '@/db.js'
import * as incidents from '@/incidents.js'
import * as plays from '@/plays/index.js'
import * as plexSync from '@/plexSync.js'
import * as plex from '@/probes/plex.js'
import * as rollups from '@/rollups.js'
import * as store from '@/store.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { addSeconds, epochSeconds } from '@/time.js'
import type { HttpResult } from '@/transport/http.js'

const T0 = new Date(Date.UTC(2026, 8, 18, 12, 0, 0))
const NOW = epochSeconds(T0)
const DAY = 86_400

const HISTORY = '/status/sessions/history/all'

// Every url is deliberately unresolvable: the transport is faked in every
// test, so a leaked real request fails loudly instead of touching the LAN.
const HOST = host({
  name: 'syrax',
  ip: '192.0.2.5',
  has_gpu: false,
  docker_url: '',
  plex_url: 'http://plex.invalid:32400',
})
const SECURE_HOST = host({
  name: 'vhagar',
  ip: '192.0.2.6',
  has_gpu: true,
  docker_url: '',
  plex_url: 'https://plex.invalid:32400',
})
const NO_PLEX = host({ name: 'ghost', ip: '192.0.2.9', has_gpu: false, docker_url: '' })

type Json = Readonly<Record<string, unknown>>

const ROOT: Json = {
  MediaContainer: {
    friendlyName: 'Syrax',
    machineIdentifier: '2fae773f4398',
    version: '1.43.4',
  },
}
const ACCOUNTS: Json = {
  MediaContainer: {
    Account: [
      { id: 1, name: 'cj' },
      { id: 42, name: 'Ann', thumb: '/a' },
    ],
  },
}
const DEVICES: Json = {
  MediaContainer: {
    Device: [{ id: 7, name: 'Chrome', platform: 'Chrome', clientIdentifier: 'c1' }],
  },
}
const SECTIONS: readonly Json[] = [
  { key: '8', type: 'movie', title: 'Films' },
  { key: '6', type: 'show', title: 'Shows' },
  { key: '99', type: 'photo', title: 'Photos' },
]

/** A ledger row, typed where the fake server reads it. */
type PlayRow = Json & Readonly<{ viewedAt: number }>

const play = ({
  historyId,
  ratingKey,
  viewedAt,
  kind = 'movie',
  title = 'Heat',
  account = 1,
}: {
  historyId: number
  ratingKey: string
  viewedAt: number
  kind?: string
  title?: string
  account?: number
}): PlayRow => ({
  historyKey: `/status/sessions/history/${historyId}`,
  ratingKey,
  type: kind,
  title,
  librarySectionID: '8',
  viewedAt,
  accountID: account,
  deviceID: 7,
})

const movie = ({
  ratingKey,
  title,
  resolution = '1080',
  width = 1920,
}: {
  ratingKey: string
  title: string
  resolution?: string
  width?: number
}): Json => ({
  ratingKey,
  type: 'movie',
  title,
  year: 1995,
  librarySectionID: '8',
  duration: 6_000_000,
  addedAt: NOW - 30 * DAY,
  thumb: `/thumb/${ratingKey}`,
  Media: [{ videoResolution: resolution, width, height: 800 }],
})

const episode = ({ ratingKey, title }: { ratingKey: string; title: string }): Json => ({
  ratingKey,
  type: 'episode',
  title,
  index: 1,
  parentIndex: 4,
  parentRatingKey: '510',
  parentTitle: 'Season 4',
  grandparentRatingKey: '500',
  grandparentTitle: 'Better Call Saul',
  librarySectionID: '6',
  duration: 2_800_000,
  addedAt: NOW - 3 * DAY,
  Media: [{ videoResolution: '1080', width: 1920, height: 1080 }],
})

const container = ({
  rows,
  total = null,
  offset = 0,
}: {
  rows: readonly Json[]
  total?: number | null
  offset?: number
}): Json => ({
  MediaContainer: {
    size: rows.length,
    totalSize: total ?? rows.length,
    offset,
    Metadata: rows,
  },
})

/** One request the fake server saw: its path, its query, its headers, and the verify switch. */
type Sent = Readonly<{
  path: string
  query: Readonly<Record<string, string>>
  headers: Readonly<Record<string, string>>
  verify: boolean
}>

/**
 * A Plex server standing behind the transport's GET.
 *
 * Pages the ledger and the sections the way the real one does, off the two
 * container headers and the `viewedAt>` filter, and refuses whatever a test
 * puts in `refuse`. `historyBudget` answers that many ledger pages and then
 * refuses, which is how a pass that dies mid-backfill is staged.
 *
 * Mutable on purpose, like the Python class it ports: a test adds a play,
 * refuses a path or clears the request log between two passes.
 */
type FakePlex = {
  history: PlayRow[]
  items: ReadonlyMap<string, Json>
  sections: readonly Json[]
  sectionItems: ReadonlyMap<string, readonly Json[]>
  refuse: Set<string>
  // paths (substrings) whose answer trickles past any budget a test sets
  stall: Set<string>
  historyBudget: number | null
  requests: Sent[]
  getJson: plexSync.GetJson
  // the transport every pass is handed, standing in for the patched module
  via: plexSync.Transport
}

const REFUSED: HttpResult = { ok: false, status: 0, body: '', reason: 'refused' }

const answer = ({
  fake,
  path,
  query,
  start,
  size,
}: {
  fake: FakePlex
  path: string
  query: Readonly<Record<string, string>>
  start: number
  size: number
}): Json | null => {
  if (path === '/') {
    return ROOT
  }
  if (path === '/accounts') {
    return ACCOUNTS
  }
  if (path === '/devices') {
    return DEVICES
  }
  if (path === HISTORY) {
    const since = Number(query['viewedAt>'] ?? '0')
    const rows = fake.history.filter((row) => row.viewedAt >= since)
    return container({ rows: rows.slice(start, start + size), total: rows.length, offset: start })
  }
  if (path.startsWith('/library/metadata/')) {
    const keys = path.slice(path.lastIndexOf('/') + 1).split(',')
    const found = keys.flatMap((key) => {
      const item = fake.items.get(key)
      return item === undefined ? [] : [item]
    })
    return found.length > 0 ? container({ rows: found }) : null
  }
  if (path === '/library/sections') {
    return { MediaContainer: { Directory: fake.sections } }
  }
  if (path.startsWith('/library/sections/') && path.endsWith('/all')) {
    const rows = fake.sectionItems.get(path.split('/')[3] ?? '') ?? []
    return container({ rows: rows.slice(start, start + size), total: rows.length, offset: start })
  }
  return null
}

const fakePlex = ({
  history = [],
  items = {},
  sections = [],
  sectionItems = {},
}: {
  history?: readonly PlayRow[]
  items?: Readonly<Record<string, Json>>
  sections?: readonly Json[]
  sectionItems?: Readonly<Record<string, readonly Json[]>>
} = {}): FakePlex => {
  const getJson: plexSync.GetJson = async ({ url, headers, verify }) => {
    const parts = new URL(url)
    const query = Object.fromEntries(parts.searchParams)
    fake.requests.push({ path: parts.pathname, query, headers: { ...headers }, verify })
    if (fake.refuse.has(parts.pathname)) {
      return REFUSED
    }
    if ([...fake.stall].some((marker) => parts.pathname.includes(marker))) {
      await sleep(1000)
    }
    if (parts.pathname === HISTORY && fake.historyBudget !== null) {
      if (fake.historyBudget <= 0) {
        return REFUSED
      }
      fake.historyBudget -= 1
    }
    const start = Number(headers['X-Plex-Container-Start'] ?? '0')
    const size = Number(headers['X-Plex-Container-Size'] ?? '1000000')
    const body = answer({ fake, path: parts.pathname, query, start, size })
    if (body === null) {
      return { ok: false, status: 404, body: '', reason: 'http_404' }
    }
    return { ok: true, status: 200, body: JSON.stringify(body), reason: '' }
  }
  const fake: FakePlex = {
    history: history.toSorted((a, b) => a.viewedAt - b.viewedAt),
    items: new Map(Object.entries(items)),
    sections,
    sectionItems: new Map(Object.entries(sectionItems)),
    refuse: new Set(),
    stall: new Set(),
    historyBudget: null,
    requests: [],
    getJson,
    via: plexSync.transport({ get: getJson }),
  }
  return fake
}

/**
 * The pytest `path` fixture: a fresh file with every table
 * `collector.init_db` creates, built from the modules it calls so this suite
 * does not wait on the collector port.
 */
const initialisedPath = (): string => {
  const path = tempDbPath()
  session({
    path,
    work: (connection) => {
      store.initDb(connection)
      rollups.initDb(connection)
      incidents.initDb(connection)
      plays.initDb(connection)
    },
  })
  return path
}

const rows = ({
  path,
  sql,
  params = [],
}: {
  path: string
  sql: string
  params?: readonly unknown[]
}): readonly unknown[] =>
  session({
    path,
    mode: 'read',
    work: (connection) =>
      connection
        .prepare(sql)
        .raw()
        .all(...params),
  })

/** The value a lookup found, or a failed test when it found nothing. */
const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('expected a value, found none')
  }
  return value
}

const status = (path: string): plays.ServerStatus =>
  must(
    session({
      path,
      mode: 'read',
      work: (connection) => plays.syncStatus({ connection, hosts: [HOST] }).at(0),
    }),
  )

const cursor = (path: string): number | null =>
  session({
    path,
    mode: 'read',
    work: (connection) => plays.historyCursor({ connection, host: HOST.name }),
  })

const seenEarlier = ({ path, item }: { path: string; item: Json }): void =>
  session({
    path,
    work: (connection) =>
      plays.upsertItems({
        connection,
        host: 'syrax',
        items: plex.parseItems({ payload: container({ rows: [item] }) }),
        seenAt: addSeconds({ at: T0, seconds: -6 * 3600 }),
      }),
  })

const paths = (fake: FakePlex): readonly string[] => fake.requests.map((sent) => sent.path)

const metadataPaths = (fake: FakePlex): readonly string[] =>
  paths(fake).filter((sent) => sent.startsWith('/library/metadata/'))

afterEach(() => {
  removeTempDirs()
  vi.unstubAllEnvs()
})

describe('plexSync', () => {
  it('backfills the ledger in pages on the first pass and enriches its items', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [
        play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 10 * DAY }),
        play({ historyId: 2, ratingKey: '101', viewedAt: NOW - 5 * DAY, title: 'Ronin' }),
        play({ historyId: 3, ratingKey: '100', viewedAt: NOW - DAY, account: 42 }),
      ],
      // 101 is gone from the library: the ledger remembers it, the metadata
      // endpoint does not
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
    })

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      pageSize: 2,
      via: fake.via,
    })

    expect(check).toEqual(incidents.checkResult({ target: 'plex:syrax', ok: true, reason: '' }))
    const pages = fake.requests.filter((sent) => sent.path === HISTORY)
    expect(pages.map((sent) => sent.headers['X-Plex-Container-Start'])).toEqual(['0', '2'])
    pages.forEach((sent) => expect(sent.headers['X-Plex-Container-Size']).toBe('2'))
    // a year back, ascending, with the token and the json accept on every page
    pages.forEach((sent) =>
      expect(sent.query).toEqual({ sort: 'viewedAt:asc', 'viewedAt>': String(NOW - 365 * DAY) }),
    )
    pages.forEach((sent) => {
      expect(sent.headers['X-Plex-Token']).toBe('tok')
      expect(sent.headers.Accept).toBe('application/json')
    })

    expect(
      rows({ path, sql: 'SELECT history_id, rating_key, account_id FROM plex_plays ORDER BY 1' }),
    ).toEqual([
      [1, '100', 1],
      [2, '101', 1],
      [3, '100', 42],
    ])
    expect(cursor(path)).toBe(NOW - DAY)
    const line = status(path)
    expect([line.friendly_name, line.reachable, line.history_synced_at, line.plays]).toEqual([
      'Syrax',
      true,
      T0,
      3,
    ])
    // the played film got its metadata; the vanished one got a stub carrying
    // the ledger's own title, absent and unranked, and will not be asked again
    expect(
      rows({ path, sql: 'SELECT rating_key, title, present, quality FROM plex_items ORDER BY 1' }),
    ).toEqual([
      ['100', 'Heat', 1, '1080p'],
      ['101', 'Ronin', 0, null],
    ])
    expect(rows({ path, sql: 'SELECT account_id, name FROM plex_accounts ORDER BY 1' })).toEqual([
      [1, 'cj'],
      [42, 'Ann'],
    ])
    expect(rows({ path, sql: 'SELECT device_id, name FROM plex_devices' })).toEqual([[7, 'Chrome']])
  })

  it('resumes a later pass from the cursor with an overlap and stays idempotent', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 10 * DAY })],
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
    })
    await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    fake.history.push(play({ historyId: 2, ratingKey: '100', viewedAt: NOW - DAY }))
    fake.requests.splice(0)

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: addSeconds({ at: T0, seconds: 5 * 60 }),
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })

    expect(check).toMatchObject({ ok: true })
    const since = must(fake.requests.find((sent) => sent.path === HISTORY)).query['viewedAt>']
    // the cursor minus the overlap, not the lookback: the year is read once
    expect(since).toBe(String(NOW - 10 * DAY - 2 * DAY))
    // the overlap re-read the first play and inserted nothing twice
    expect(rows({ path, sql: 'SELECT history_id FROM plex_plays ORDER BY 1' })).toEqual([[1], [2]])
    expect(cursor(path)).toBe(NOW - DAY)
    // nothing was missing, so nothing was asked about
    expect(metadataPaths(fake)).toEqual([])
  })

  it('keeps the pages that landed when a pass dies mid-backfill', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [1, 2, 3, 4].map((i) =>
        play({ historyId: i, ratingKey: '100', viewedAt: NOW - i * DAY }),
      ),
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
    })
    fake.historyBudget = 1

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      pageSize: 2,
      via: fake.via,
    })

    expect(check).toEqual(
      incidents.checkResult({ target: 'plex:syrax', ok: false, reason: 'refused' }),
    )
    // ascending, so the oldest two landed and the cursor stands on them: the
    // next pass starts there rather than at the start of the year
    expect(rows({ path, sql: 'SELECT history_id FROM plex_plays ORDER BY 1' })).toEqual([[3], [4]])
    expect(cursor(path)).toBe(NOW - 3 * DAY)
    const line = status(path)
    expect([line.reachable, line.last_error, line.history_synced_at]).toEqual([
      false,
      'refused',
      T0,
    ])
  })

  it('records a missing token without touching the server', async () => {
    const path = initialisedPath()
    const fake = fakePlex()

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: '',
      lookbackDays: 365,
      via: fake.via,
    })

    expect(check).toEqual(
      incidents.checkResult({ target: 'plex:syrax', ok: false, reason: 'no_token' }),
    )
    expect(fake.requests).toEqual([])
    const line = status(path)
    expect([line.reachable, line.last_error, line.history_synced_at]).toEqual([
      false,
      'no_token',
      T0,
    ])
  })

  it('records a server that refuses and reads it no further', async () => {
    const path = initialisedPath()
    const fake = fakePlex()
    fake.refuse.add('/')

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })

    expect(check).toEqual(
      incidents.checkResult({ target: 'plex:syrax', ok: false, reason: 'refused' }),
    )
    expect(paths(fake)).toEqual(['/'])
    const openTargets = (): ReadonlySet<string> =>
      session({
        path,
        mode: 'read',
        work: (connection) =>
          new Set(incidents.openIncidents(connection).map((incident) => incident.target)),
      })
    expect(openTargets()).toEqual(new Set())
    // a second failure, one interval later, is what opens the incident
    await plexSync.syncHistory({
      host: HOST,
      path,
      now: addSeconds({ at: T0, seconds: PLEX_HISTORY_INTERVAL }),
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    expect(openTargets()).toEqual(new Set(['plex:syrax']))
  })

  it('skips a host without Plex entirely', async () => {
    const path = initialisedPath()
    const fake = fakePlex()

    expect(
      await plexSync.syncHistory({
        host: NO_PLEX,
        path,
        now: T0,
        token: 'tok',
        lookbackDays: 365,
        via: fake.via,
      }),
    ).toBeNull()
    expect(
      await plexSync.syncLibrary({ host: NO_PLEX, path, now: T0, token: 'tok', via: fake.via }),
    ).toBe(false)
    expect(fake.requests).toEqual([])
  })

  it('reads the secure servers without certificate verification', async () => {
    const path = initialisedPath()
    const fake = fakePlex()

    await plexSync.syncHistory({
      host: SECURE_HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    expect(new Set(fake.requests.map((sent) => sent.verify))).toEqual(new Set([false]))
    fake.requests.splice(0)

    await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    expect(new Set(fake.requests.map((sent) => sent.verify))).toEqual(new Set([true]))
  })

  it('stubs items the server no longer has once', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [play({ historyId: 1, ratingKey: '777', viewedAt: NOW - DAY, title: 'Vanished' })],
    })
    await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    fake.requests.splice(0)

    await plexSync.syncHistory({
      host: HOST,
      path,
      now: addSeconds({ at: T0, seconds: 5 * 60 }),
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })

    expect(metadataPaths(fake)).toEqual([])
    expect(
      rows({
        path,
        sql: "SELECT title, present, quality FROM plex_items WHERE rating_key = '777'",
      }),
    ).toEqual([['Vanished', 0, null]])
  })

  it('upserts every section on a complete inventory and retires what is gone', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      sections: SECTIONS,
      sectionItems: {
        '8': [
          movie({ ratingKey: '100', title: 'Heat' }),
          movie({ ratingKey: '102', title: 'Ronin' }),
        ],
        '6': [episode({ ratingKey: '600', title: 'Smoke' })],
      },
    })
    // an item a previous run saw that the library no longer lists
    seenEarlier({ path, item: movie({ ratingKey: '103', title: 'Gone' }) })

    const complete = await plexSync.syncLibrary({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      pageSize: 1,
      via: fake.via,
    })

    expect(complete).toBe(true)
    const listed = fake.requests
      .filter((sent) => sent.path.endsWith('/all'))
      .map((sent) => [sent.path, sent.headers['X-Plex-Container-Start'], sent.query.type])
    // movies by type 1, episodes by type 4, a page per item at this size, and
    // the photo section never asked for
    expect(listed).toEqual([
      ['/library/sections/8/all', '0', '1'],
      ['/library/sections/8/all', '1', '1'],
      ['/library/sections/6/all', '0', '4'],
    ])
    expect(rows({ path, sql: 'SELECT rating_key, present FROM plex_items ORDER BY 1' })).toEqual([
      ['100', 1],
      ['102', 1],
      ['103', 0],
      ['600', 1],
    ])
    expect(
      rows({ path, sql: 'SELECT section_id, kind, title FROM plex_sections ORDER BY 1' }),
    ).toEqual([
      ['6', 'episode', 'Shows'],
      ['8', 'movie', 'Films'],
    ])
    const line = status(path)
    expect([line.library_synced_at, line.items]).toEqual([T0, 3])
  })

  it('retires nothing on a partial inventory', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      sections: SECTIONS,
      sectionItems: {
        '8': [movie({ ratingKey: '100', title: 'Heat' })],
        '6': [episode({ ratingKey: '600', title: 'Smoke' })],
      },
    })
    fake.refuse.add('/library/sections/6/all')
    seenEarlier({ path, item: movie({ ratingKey: '103', title: 'Gone' }) })

    const complete = await plexSync.syncLibrary({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      via: fake.via,
    })

    expect(complete).toBe(false)
    // Gone stays present: the run could not vouch for the shows section, so it
    // cannot say what is missing from the films either
    expect(rows({ path, sql: 'SELECT rating_key, present FROM plex_items ORDER BY 1' })).toEqual([
      ['100', 1],
      ['103', 1],
    ])
    const line = status(path)
    expect([line.library_synced_at, line.last_error]).toEqual([T0, 'refused'])
  })

  it('marks the pass when the sections listing fails', async () => {
    const path = initialisedPath()
    const fake = fakePlex({ sections: SECTIONS })
    fake.refuse.add('/library/sections')

    expect(
      await plexSync.syncLibrary({ host: HOST, path, now: T0, token: 'tok', via: fake.via }),
    ).toBe(false)
    expect(status(path).last_error).toBe('refused')
  })

  it('runs the inventory in syncHost only after a history pass reached the server', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      sections: SECTIONS,
      sectionItems: { '8': [movie({ ratingKey: '100', title: 'Heat' })] },
    })

    const due = await plexSync.syncHost({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      inventoryDue: true,
      via: fake.via,
    })
    expect(due).toEqual({ history_ok: true, inventory_ran: true, inventory_complete: true })

    fake.requests.splice(0)
    const notDue = await plexSync.syncHost({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      inventoryDue: false,
      via: fake.via,
    })
    expect(notDue.inventory_ran).toBe(false)
    expect(new Set(paths(fake)).has('/library/sections')).toBe(false)

    fake.refuse.add('/')
    const unreachable = await plexSync.syncHost({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      inventoryDue: true,
      via: fake.via,
    })
    expect(unreachable).toEqual({
      history_ok: false,
      inventory_ran: false,
      inventory_complete: false,
    })
  })

  it('fans runRound out over the configured Plex hosts', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [play({ historyId: 1, ratingKey: '100', viewedAt: NOW - DAY })],
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
      sections: SECTIONS,
      sectionItems: { '8': [movie({ ratingKey: '100', title: 'Heat' })] },
    })
    vi.stubEnv('FM_PLEX_TOKEN', 'tok')

    const outcomes = await plexSync.runRound({
      path,
      now: T0,
      inventoryDue: new Set(['syrax']),
      hosts: [HOST, SECURE_HOST, NO_PLEX],
      via: fake.via,
    })

    expect(new Set(Object.keys(outcomes))).toEqual(new Set(['syrax', 'vhagar']))
    const syrax = must(outcomes.syrax)
    const vhagar = must(outcomes.vhagar)
    expect(syrax.inventory_ran && syrax.inventory_complete).toBe(true)
    expect(vhagar.history_ok && !vhagar.inventory_ran).toBe(true)
    expect(rows({ path, sql: 'SELECT DISTINCT host FROM plex_plays ORDER BY 1' })).toEqual([
      ['syrax'],
      ['vhagar'],
    ])
  })

  it('inventories every host on runOnce and creates what it writes', async () => {
    const fake = fakePlex({ sections: SECTIONS })
    vi.stubEnv('FM_PLEX_TOKEN', 'tok')
    // a fresh file nothing has initialised: the first live run died here, on
    // the check table the vitals collector would normally have created
    const fresh = tempDbPath()

    const outcomes = await plexSync.runOnce({
      path: fresh,
      hosts: [HOST, SECURE_HOST],
      via: fake.via,
    })

    expect(new Set(Object.keys(outcomes))).toEqual(new Set(['syrax', 'vhagar']))
    expect(
      Object.values(outcomes).every((outcome) => outcome.history_ok && outcome.inventory_ran),
    ).toBe(true)
    expect(status(fresh).reachable).toBe(true)
  })

  it('enriches only what the listing left out on an inventory round', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [
        play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 2 * DAY }),
        play({ historyId: 2, ratingKey: '777', viewedAt: NOW - DAY, title: 'Vanished' }),
      ],
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
      sections: SECTIONS,
      sectionItems: { '8': [movie({ ratingKey: '100', title: 'Heat' })] },
    })

    const outcome = await plexSync.syncHost({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      inventoryDue: true,
      via: fake.via,
    })

    expect(outcome).toEqual({ history_ok: true, inventory_ran: true, inventory_complete: true })
    const seen = paths(fake)
    // the listing came before any metadata request, and metadata was asked
    // only for the one played item the listing did not describe: on a fresh
    // database that is the difference between a few requests and a thousand
    // (both are looked up, as Python's list.index raised on a missing one)
    expect(seen).toContain('/library/sections')
    expect(seen).toContain('/library/metadata/777')
    expect(seen.indexOf('/library/sections')).toBeLessThan(seen.indexOf('/library/metadata/777'))
    expect(metadataPaths(fake)).toEqual(['/library/metadata/777'])
    expect(rows({ path, sql: 'SELECT rating_key, present FROM plex_items ORDER BY 1' })).toEqual([
      ['100', 1],
      ['777', 0],
    ])
  })

  it('reads a request that trickles past its budget as a timeout', async () => {
    // the transport's timeout is per read; vermithor answered one page's
    // headers at once and then took fifty-nine minutes over the body
    const fake = fakePlex()
    fake.stall.add('/accounts')
    const via = plexSync.transport({ get: fake.getJson, timeout: 0.05 })

    expect(await plexSync.fetch({ host: HOST, path: '/accounts', token: 'tok', via })).toEqual({
      payload: null,
      reason: 'timeout',
    })
    expect((await plexSync.fetch({ host: HOST, path: '/', token: 'tok', via })).reason).toBe('')
  })

  it('stubs a key that stalls alone and keeps the rest', async () => {
    const path = initialisedPath()
    const fake = fakePlex({
      history: [
        play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 2 * DAY }),
        play({ historyId: 2, ratingKey: '666', viewedAt: NOW - DAY, title: 'Stalls' }),
        play({ historyId: 3, ratingKey: '102', viewedAt: NOW - DAY, title: 'Ronin' }),
      ],
      items: {
        '100': movie({ ratingKey: '100', title: 'Heat' }),
        '666': movie({ ratingKey: '666', title: 'Stalls' }),
        '102': movie({ ratingKey: '102', title: 'Ronin' }),
      },
    })
    // any metadata request naming this key trickles past the budget
    fake.stall.add('666')
    const via = plexSync.transport({ get: fake.getJson, timeout: 0.05 })

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via,
    })

    // the batch stalled, so every key was asked for alone; the two that
    // answered are kept, the one that stalled by itself is stubbed, and the
    // pass still counts as having reached the server
    expect(check).toMatchObject({ ok: true })
    expect(metadataPaths(fake)).toEqual([
      '/library/metadata/100,102,666',
      '/library/metadata/100',
      '/library/metadata/102',
      '/library/metadata/666',
    ])
    expect(
      rows({ path, sql: 'SELECT rating_key, title, present FROM plex_items ORDER BY 1' }),
    ).toEqual([
      ['100', 'Heat', 1],
      ['102', 'Ronin', 1],
      ['666', 'Stalls', 0],
    ])
    // and nothing is asked for again on the next pass
    fake.requests.splice(0)
    await plexSync.syncHistory({
      host: HOST,
      path,
      now: addSeconds({ at: T0, seconds: 5 * 60 }),
      token: 'tok',
      lookbackDays: 365,
      via,
    })
    expect(metadataPaths(fake)).toEqual([])
  })

  it('carries the section an inventory row was listed under', async () => {
    // the listing omits librarySectionID on each row, so the never-played
    // list used to show every title with no library beside it
    const path = initialisedPath()
    const fake = fakePlex({
      sections: SECTIONS,
      sectionItems: {
        '8': [movie({ ratingKey: '100', title: 'Heat' })],
        '6': [episode({ ratingKey: '600', title: 'Smoke' })],
      },
    })

    await plexSync.syncLibrary({ host: HOST, path, now: T0, token: 'tok', via: fake.via })

    expect(rows({ path, sql: 'SELECT rating_key, section_id FROM plex_items ORDER BY 1' })).toEqual(
      [
        ['100', '8'],
        ['600', '6'],
      ],
    )
    const page = session({
      path,
      work: (connection) =>
        plays.neverPlayed({
          connection,
          filters: plays.filters(),
          hosts: ['syrax'],
          page: 1,
          pageSize: 10,
          q: '',
          now: T0,
        }),
    })
    expect(new Set(page.rows.map((row) => [row.title, row.library]))).toEqual(
      new Set([
        ['Heat', 'Films'],
        ['Better Call Saul', 'Shows'],
      ]),
    )
  })

  // Not in the Python suite: the shutdown signal is new with the port, and
  // the collector stops this loop with it on SIGTERM.
  it('returns from runForever once its signal aborts, without waiting out the interval', async () => {
    // no token, so every host fails its pass without a request leaving the box
    vi.stubEnv('FM_PLEX_TOKEN', '')
    vi.stubEnv('PLEX_TOKEN', '')
    const path = tempDbPath()
    const controller = new AbortController()

    const running = plexSync.runForever({ path, signal: controller.signal })
    // the first round lands, and the loop settles into its five minute sleep
    await vi.waitFor(() =>
      expect(
        rows({ path, sql: "SELECT COUNT(*) FROM plex_servers WHERE last_error = 'no_token'" }),
      ).toEqual([[plexHosts().length]]),
    )
    controller.abort()

    await expect(running).resolves.toBeUndefined()
  })

  // Not in the Python suite either: what the signal does to a request in flight.
  it('abandons a request in flight on abort and records no failed check for it', async () => {
    vi.stubEnv('FM_PLEX_TOKEN', 'tok')
    const path = initialisedPath()
    const fake = fakePlex()
    fake.stall.add('/accounts')
    const controller = new AbortController()

    const round = plexSync.runRound({
      path,
      now: T0,
      inventoryDue: new Set(),
      hosts: [HOST],
      via: plexSync.transport({ get: fake.getJson, signal: controller.signal }),
    })
    await vi.waitFor(() => expect(paths(fake)).toContain('/accounts'))
    controller.abort()

    // the abort surfaces as itself, which is what logRaised rethrows, rather
    // than as a timeout that would count against the server
    await expect(round).rejects.toMatchObject({ name: 'AbortError' })
    expect(status(path).last_error).toBeNull()
    expect(rows({ path, sql: 'SELECT COUNT(*) FROM check_streak' })).toEqual([[0]])
  })

  // Not in the Python suite either: the production GET, end to end against a
  // loopback server rather than the fake.
  it('sends through getJson by default and closes a request abandoned on abort', async () => {
    const seen: IncomingMessage[] = []
    const closed: string[] = []
    const server = createServer((request, response) => {
      seen.push(request)
      if (request.url === '/') {
        response.end(JSON.stringify(ROOT))
        return
      }
      // anything else is never answered, like a server wedged mid-request
      response.on('close', () => closed.push(request.url ?? ''))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('no port was bound')
      }
      const local = host({
        name: 'local',
        ip: '127.0.0.1',
        has_gpu: false,
        docker_url: '',
        plex_url: `http://127.0.0.1:${address.port}`,
      })

      expect(await plexSync.fetch({ host: local, path: '/', token: 'tok' })).toEqual({
        payload: ROOT,
        reason: '',
      })
      const sent = must(seen.at(0)).headers
      expect([sent['x-plex-token'], sent.accept]).toEqual(['tok', 'application/json'])

      // the budget is the full ninety seconds, so only the abort reaching the
      // wire can close this socket inside the wait below
      const controller = new AbortController()
      const pending = plexSync.fetch({
        host: local,
        path: '/wedged',
        token: 'tok',
        via: plexSync.transport({ signal: controller.signal }),
      })
      await vi.waitFor(() => expect(seen.map((request) => request.url)).toContain('/wedged'))
      controller.abort()

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(closed).toEqual(['/wedged']))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// --- excluded libraries ---------------------------------------------------

describe('excluded libraries', () => {
  // caraxes indexes a scratch tree as four movie libraries (measured 2026-09-19)
  const SCRATCH_SECTIONS: readonly Json[] = [
    {
      key: '8',
      type: 'movie',
      title: 'Films',
      Location: [{ path: '/volume1/Caraxes/Media/Movies' }],
    },
    {
      key: '16',
      type: 'movie',
      title: '99. Tutorials',
      Location: [{ path: '/volume1/Caraxes/tmp/Tutorials' }],
    },
    {
      key: '20',
      type: 'movie',
      title: '97. Home Videos',
      Location: [{ path: '/volume1/Caraxes/tmp/Home Videos' }],
    },
  ]

  const librarySection = ({
    sectionId,
    locations = [],
    kind = 'movie',
  }: {
    sectionId: string
    locations?: readonly string[]
    kind?: plex.Kind
  }): plex.Section => plex.section({ section_id: sectionId, title: sectionId, kind, locations })

  const scratchPlay = ({
    historyId,
    ratingKey,
    sectionId,
    viewedAt,
  }: {
    historyId: number
    ratingKey: string
    sectionId: string
    viewedAt: number
  }): PlayRow => ({ ...play({ historyId, ratingKey, viewedAt }), librarySectionID: sectionId })

  const scratchMovie = ({
    ratingKey,
    title,
    sectionId,
  }: {
    ratingKey: string
    title: string
    sectionId: string
  }): Json => ({ ...movie({ ratingKey, title }), librarySectionID: sectionId })

  it.each([
    ['/volume1/Caraxes/tmp', true],
    ['/volume1/Caraxes/tmp/', true],
    ['/volume1/Caraxes/tmp/Tutorials', true],
    ['/volume1/Caraxes/tmp/Home Videos/2019', true],
    ['/VOLUME1/CARAXES/TMP/Tutorials', true],
    // a sibling folder whose name merely starts the same way
    ['/volume1/Caraxes/tmp-restore/Tutorials', false],
    ['/volume1/Caraxes/Media/Movies', false],
    ['/volume1/Meleys/Caraxes/Media/TV/A', false],
  ] as const)(
    'excludes a location only when it is inside the folder (%s)',
    (location, excluded) => {
      const ids = plexSync.excludedSections({
        sections: [librarySection({ sectionId: '16', locations: [location] })],
        folders: ['/volume1/Caraxes/tmp'],
      })

      expect(ids.has('16')).toBe(excluded)
    },
  )

  it('excludes a library only when every one of its folders is', () => {
    const sections = [
      librarySection({ sectionId: '16', locations: ['/volume1/Caraxes/tmp/Tutorials'] }),
      // both folders excluded
      librarySection({
        sectionId: '19',
        locations: ['/volume1/Caraxes/tmp/Documents', '/volume1/Caraxes/tmp/Assignments'],
      }),
      // one real folder among them: the page still has to count it
      librarySection({
        sectionId: '8',
        locations: ['/volume1/Caraxes/tmp/Extras', '/volume1/Caraxes/Media/Movies'],
      }),
      // a section the server answers for with no folder behind it
      librarySection({ sectionId: '30' }),
    ]

    expect(plexSync.excludedSections({ sections, folders: ['/volume1/Caraxes/tmp'] })).toEqual(
      new Set(['16', '19']),
    )
  })

  it('excludes nothing when no folders are excluded', () => {
    expect(
      plexSync.excludedSections({
        sections: [librarySection({ sectionId: '16', locations: ['/anything'] })],
        folders: [],
      }),
    ).toEqual(new Set())
  })

  it('marks the excluded libraries on an inventory and never pages them', async () => {
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', '/volume1/Caraxes/tmp')
    const path = initialisedPath()
    const fake = fakePlex({
      sections: SCRATCH_SECTIONS,
      sectionItems: {
        '8': [movie({ ratingKey: '100', title: 'Heat' })],
        '16': [scratchMovie({ ratingKey: '900', title: 'How to grep', sectionId: '16' })],
        '20': [scratchMovie({ ratingKey: '901', title: 'Birthday', sectionId: '20' })],
      },
    })

    const complete = await plexSync.syncLibrary({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      via: fake.via,
    })

    expect(complete).toBe(true)
    expect(paths(fake).filter((sent) => sent.endsWith('/all'))).toEqual(['/library/sections/8/all'])
    expect(rows({ path, sql: 'SELECT rating_key FROM plex_items ORDER BY 1' })).toEqual([['100']])
    // the sections themselves stay, carrying the flag the history pass reads
    expect(
      rows({ path, sql: 'SELECT section_id, excluded FROM plex_sections ORDER BY 1' }),
    ).toEqual([
      ['16', 1],
      ['20', 1],
      ['8', 0],
    ])
  })

  it('purges what an earlier pass stored on an inventory', async () => {
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', '/volume1/Caraxes/tmp')
    const path = initialisedPath()
    // the state the loop was in before the rule existed: a tutorial watched
    // twice, its item inventoried, beside a film that stays
    const fake = fakePlex({
      history: [
        scratchPlay({ historyId: 1, ratingKey: '900', sectionId: '16', viewedAt: NOW - 3 * DAY }),
        scratchPlay({ historyId: 2, ratingKey: '900', sectionId: '16', viewedAt: NOW - 2 * DAY }),
        play({ historyId: 3, ratingKey: '100', viewedAt: NOW - DAY }),
      ],
      items: {
        '100': movie({ ratingKey: '100', title: 'Heat' }),
        '900': scratchMovie({ ratingKey: '900', title: 'How to grep', sectionId: '16' }),
      },
      sections: SCRATCH_SECTIONS,
      sectionItems: {
        '8': [movie({ ratingKey: '100', title: 'Heat' })],
        '16': [scratchMovie({ ratingKey: '900', title: 'How to grep', sectionId: '16' })],
      },
    })
    await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })
    expect(rows({ path, sql: 'SELECT COUNT(*) FROM plex_plays' })).toEqual([[3]])

    await plexSync.syncLibrary({ host: HOST, path, now: T0, token: 'tok', via: fake.via })

    expect(rows({ path, sql: 'SELECT rating_key FROM plex_plays ORDER BY 1' })).toEqual([['100']])
    expect(rows({ path, sql: 'SELECT rating_key FROM plex_items ORDER BY 1' })).toEqual([['100']])
  })

  it('drops the excluded plays on a history pass and still moves the cursor', async () => {
    vi.stubEnv('FM_PLEX_EXCLUDED_PATHS', '/volume1/Caraxes/tmp')
    const path = initialisedPath()
    const fake = fakePlex({
      history: [
        play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 3 * DAY }),
        scratchPlay({ historyId: 2, ratingKey: '900', sectionId: '16', viewedAt: NOW - DAY }),
      ],
      items: { '100': movie({ ratingKey: '100', title: 'Heat' }) },
      sections: SCRATCH_SECTIONS,
      sectionItems: { '8': [movie({ ratingKey: '100', title: 'Heat' })] },
    })
    // the inventory is what marks them, and it runs on the loop's first round
    await plexSync.syncLibrary({ host: HOST, path, now: T0, token: 'tok', via: fake.via })

    const check = await plexSync.syncHistory({
      host: HOST,
      path,
      now: T0,
      token: 'tok',
      lookbackDays: 365,
      via: fake.via,
    })

    expect(check).toMatchObject({ ok: true })
    expect(rows({ path, sql: 'SELECT rating_key FROM plex_plays ORDER BY 1' })).toEqual([['100']])
    // the newest play read, excluded or not: re-reading that page would only
    // drop the same row again
    expect(cursor(path)).toBe(NOW - DAY)
    // and nothing asks the metadata endpoint about an item nobody kept
    expect(rows({ path, sql: 'SELECT rating_key FROM plex_items ORDER BY 1' })).toEqual([['100']])
  })
})
