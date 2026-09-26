// The play-history routes over HTTP, against one seeded Plex server.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '@/collector.js'
import { session } from '@/db.js'
import * as plays from '@/plays/index.js'
import type { Kind, MediaItem, PlayEntry, Quality } from '@/probes/plex.js'
import { appPastTheGate } from '@/test/apiApp.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import {
  bodyOf,
  isNeverPlayed,
  isPlaySync,
  isPlaysOverview,
  isPlayUsers,
  isTitleHistory,
  isTopTitles,
  isViewerHistory,
} from '@/test/wire.js'
import { epochSeconds } from '@/time.js'

const T0 = new Date(Date.UTC(2026, 8, 18, 12, 0, 0))
const NOW = epochSeconds(T0)
const DAY = 86_400

// config order, which is what every by-host list keeps: the portal binds a
// colour per position, the same binding the fleet page uses
const PLEX_HOSTS = ['meleys', 'vermithor', 'caraxes', 'syrax', 'vhagar']

const item = ({
  ratingKey,
  kind = 'movie',
  title = 'Heat',
  quality = '4k',
  addedAt = NOW - 30 * DAY,
  parentRatingKey = null,
  parentTitle = null,
  parentIndex = null,
  grandparentRatingKey = null,
  grandparentTitle = null,
  index = null,
}: {
  ratingKey: string
  kind?: Kind
  title?: string
  quality?: Quality
  addedAt?: number
  parentRatingKey?: string | null
  parentTitle?: string | null
  parentIndex?: number | null
  grandparentRatingKey?: string | null
  grandparentTitle?: string | null
  index?: number | null
}): MediaItem => ({
  rating_key: ratingKey,
  kind,
  title,
  parent_rating_key: parentRatingKey,
  parent_title: parentTitle,
  parent_index: parentIndex,
  grandparent_rating_key: grandparentRatingKey,
  grandparent_title: grandparentTitle,
  index,
  year: kind === 'movie' ? 1995 : null,
  section_id: '8',
  duration_ms: 6_000_000,
  video_resolution: null,
  width: null,
  height: null,
  quality,
  thumb: null,
  added_at: addedAt,
})

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
  kind?: Kind
  title?: string
  account?: number
}): PlayEntry => ({
  history_id: historyId,
  rating_key: ratingKey,
  kind,
  title,
  section_id: '8',
  account_id: account,
  device_id: null,
  viewed_at: viewedAt,
})

/**
 * One server: a film cj finished twice and Ann once, an episode watched over
 * a year ago, and a film nobody has touched.
 */
const seed = (db: string): void =>
  session({
    path: db,
    work: (connection) => {
      plays.upsertServer({
        connection,
        host: 'meleys',
        info: { friendly_name: 'Meleys', machine_id: 'm', version: '1.43.4' },
      })
      plays.markHistory({ connection, host: 'meleys', at: T0, ok: true, error: null })
      plays.upsertAccounts({
        connection,
        host: 'meleys',
        accounts: [
          { account_id: 1, name: 'cj', thumb: null },
          { account_id: 42, name: 'Ann', thumb: null },
        ],
      })
      plays.upsertItems({
        connection,
        host: 'meleys',
        items: [
          item({ ratingKey: '100' }),
          item({
            ratingKey: '200',
            kind: 'episode',
            title: 'Smoke',
            quality: '1080p',
            grandparentRatingKey: '500',
            grandparentTitle: 'Better Call Saul',
            parentRatingKey: '510',
            parentTitle: 'Season 4',
            index: 1,
            parentIndex: 4,
          }),
          item({ ratingKey: '300', title: 'Never Watched', quality: '1080p', addedAt: NOW - DAY }),
        ],
        seenAt: T0,
      })
      plays.insertPlays({
        connection,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey: '100', viewedAt: NOW - 2 * DAY }),
          play({ historyId: 2, ratingKey: '100', viewedAt: NOW - DAY }),
          play({ historyId: 3, ratingKey: '100', viewedAt: NOW - 3 * DAY, account: 42 }),
          play({
            historyId: 4,
            ratingKey: '200',
            viewedAt: NOW - 400 * DAY,
            kind: 'episode',
            title: 'Smoke',
          }),
        ],
      })
    },
  })

describe('the play history API', () => {
  let app: NestFastifyApplication
  let db: string

  // An app already past the admin gate; the gate itself is tested for real
  // in auth.test.ts, where these routes are listed as gated.
  beforeEach(async () => {
    db = tempDbPath()
    initDb(db)
    vi.stubEnv('FM_DB_PATH', db)
    app = await appPastTheGate()
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  const get = (url: string) => app.inject({ method: 'GET', url })

  const overview = async (query = '') =>
    bodyOf({ answer: await get(`/plays/overview${query}`), is: isPlaysOverview })

  const viewerHistory = async (url: string) =>
    bodyOf({ answer: await get(url), is: isViewerHistory })

  const titleHistory = async (query: string) =>
    bodyOf({ answer: await get(`/plays/title?${query}`), is: isTitleHistory })

  const neverPlayed = async (query = '') =>
    bodyOf({ answer: await get(`/plays/never-played${query}`), is: isNeverPlayed })

  it('answers the overview with zero-filled buckets in config host order', async () => {
    seed(db)

    const body = await overview()

    expect(body.window.days).toBe(365)
    expect(body.window.since).not.toBeNull()
    expect([body.window.host, body.window.kind, body.window.quality]).toEqual([null, null, null])
    expect(body.totals).toEqual({ plays: 3, viewers: 2, titles: 1, watch_ms: 18_000_000 })
    expect(body.by_kind).toEqual([
      { kind: 'movie', plays: 3 },
      { kind: 'episode', plays: 0 },
      { kind: 'track', plays: 0 },
    ])
    expect(body.by_quality.map((bucket) => bucket.quality)).toEqual([
      '4k',
      '1080p',
      '720p',
      'other',
    ])
    expect(body.by_quality[0].plays).toBe(3)
    expect(body.by_host.map((bucket) => bucket.host)).toEqual(PLEX_HOSTS)
    expect(body.by_host[0]).toEqual({ host: 'meleys', friendly_name: 'Meleys', plays: 3 })
    expect(body.by_host[1]).toEqual({ host: 'vermithor', friendly_name: null, plays: 0 })
    expect(body.timeline.bucket).toBe('month')
    expect(body.timeline.points.reduce((sum, point) => sum + point.plays, 0)).toBe(3)
    expect(body.timeline.points.every((point) => point.hosts.meleys === point.plays)).toBe(true)
    expect(body.timeline.points.every((point) => Object.keys(point.hosts).length === 1)).toBe(true)
    expect(body.top_viewers).toEqual([
      { account_id: 1, name: 'cj', plays: 2 },
      { account_id: 42, name: 'Ann', plays: 1 },
    ])
    expect(body.top_titles.map((title) => [title.title, title.plays, title.rewatches])).toEqual([
      ['Heat', 3, 1],
    ])
  })

  it('reads days=0 as all time', async () => {
    seed(db)

    const body = await overview('?days=0')

    expect(body.window).toEqual({ days: 0, since: null, host: null, kind: null, quality: null })
    expect(body.totals.plays).toBe(4)
    expect(body.by_kind[1]).toEqual({ kind: 'episode', plays: 1 })
  })

  it('narrows the read by the filters and answers a bad filter as a client error', async () => {
    seed(db)

    const narrowed = await overview('?host=meleys&kind=movie&quality=4k')
    expect(narrowed.totals.plays).toBe(3)
    expect(narrowed.window).toEqual({
      days: 365,
      since: narrowed.window.since,
      host: 'meleys',
      kind: 'movie',
      quality: '4k',
    })
    expect((await overview('?host=syrax')).totals.plays).toBe(0)
    expect((await overview('?quality=other')).totals.plays).toBe(0)

    // the fleet is known, so a host nobody has is refused rather than
    // answered for nobody; the enumerations and the bounds likewise
    const unknown = await get('/plays/overview?host=nope')
    expect(unknown.statusCode).toBe(422)
    // not in the Python test: the detail quotes the host the way Python's
    // repr() did, which is the text the page shows
    expect(unknown.json()).toEqual({ detail: "unknown host 'nope'" })
    expect((await get('/plays/overview?kind=clip')).statusCode).toBe(422)
    expect((await get('/plays/overview?quality=hd')).statusCode).toBe(422)
    expect((await get('/plays/overview?days=-1')).statusCode).toBe(422)
    expect((await get('/plays/overview?days=99999')).statusCode).toBe(422)
  })

  it("lists the users and pages one viewer's history", async () => {
    seed(db)

    const { users } = bodyOf({ answer: await get('/plays/users'), is: isPlayUsers })
    expect(
      users.map((user) => [user.account_id, user.name, user.plays, user.movies, user.episodes]),
    ).toEqual([
      [1, 'cj', 2, 2, 0],
      [42, 'Ann', 1, 1, 0],
    ])
    expect(users[0].hosts).toEqual(['meleys'])
    expect(users[0].top_title).toBe('Heat')
    expect(users[0].last_viewed_at).toMatch(/^2026-09-17/)

    const first = await viewerHistory('/plays/users/1/history?page=1&page_size=1')
    expect([first.account_id, first.name, first.total, first.page, first.page_size]).toEqual([
      1,
      'cj',
      2,
      1,
      1,
    ])
    const [row] = first.rows
    expect([row.title, row.kind, row.quality, row.host, row.year]).toEqual([
      'Heat',
      'movie',
      '4k',
      'meleys',
      1995,
    ])
    expect(row.viewed_at).toMatch(/^2026-09-17/)
    const second = await viewerHistory('/plays/users/1/history?page=2&page_size=1')
    expect(second.rows.map((entry) => entry.viewed_at.slice(0, 10))).toEqual(['2026-09-16'])

    // the window applies here too: the episode is outside the year
    expect((await viewerHistory('/plays/users/1/history?days=0')).total).toBe(3)
    // a viewer nobody has named, or nobody at all, is still an answer
    expect(await viewerHistory('/plays/users/999/history')).toEqual({
      account_id: 999,
      name: 'account 999',
      total: 0,
      page: 1,
      page_size: 50,
      rows: [],
    })
    expect((await get('/plays/users/1/history?page_size=0')).statusCode).toBe(422)
    expect((await get('/plays/users/1/history?page=0')).statusCode).toBe(422)
  })

  it('echoes the metric with the top titles and leaves the unrewatched out of rewatches', async () => {
    seed(db)

    const top = bodyOf({
      answer: await get('/plays/top?metric=plays&limit=5&days=0'),
      is: isTopTitles,
    })
    expect(top.metric).toBe('plays')
    expect(top.titles.map((title) => title.title)).toEqual(['Heat', 'Better Call Saul'])
    const [heat] = top.titles
    expect([
      heat.kind,
      heat.year,
      heat.quality,
      heat.plays,
      heat.viewers,
      heat.items,
      heat.rewatches,
      heat.context,
    ]).toEqual(['movie', 1995, '4k', 3, 2, 1, 1, null])
    expect(heat.top_rewatcher).toEqual({ account_id: 1, name: 'cj', plays: 2 })
    expect(heat.hosts).toEqual(['meleys'])
    expect(heat.last_viewed_at).toMatch(/^2026-09-17/)

    const rewatched = bodyOf({
      answer: await get('/plays/top?metric=rewatches&days=0'),
      is: isTopTitles,
    })
    expect(rewatched.metric).toBe('rewatches')
    expect(rewatched.titles.map((title) => title.title)).toEqual(['Heat'])

    expect((await get('/plays/top?metric=views')).statusCode).toBe(422)
    expect((await get('/plays/top?limit=0')).statusCode).toBe(422)
    expect((await get('/plays/top?limit=101')).statusCode).toBe(422)
  })

  it("answers one title's whole history with who finished it", async () => {
    seed(db)

    const body = await titleHistory('key=movie:heat:1995&days=0')

    expect([body.key, body.kind, body.title, body.year]).toEqual([
      'movie:heat:1995',
      'movie',
      'Heat',
      1995,
    ])
    expect([body.total, body.viewers, body.items, body.rewatches]).toEqual([3, 2, 1, 1])
    expect([body.page, body.page_size, body.hosts]).toEqual([1, 50, ['meleys']])
    expect(body.last_viewed_at).toMatch(/^2026-09-17/)
    expect(body.first_viewed_at).toMatch(/^2026-09-15/)
    expect(body.rows.map((row) => [row.viewer, row.account_id])).toEqual([
      ['cj', 1],
      ['cj', 1],
      ['Ann', 42],
    ])
    expect(body.rows[0].viewed_at).toMatch(/^2026-09-17/)

    // the key a viewer's row carries is the key that opens this page
    const [row] = (await viewerHistory('/plays/users/1/history')).rows
    expect(row.group_key).toBe('movie:heat:1995')

    const paged = await titleHistory('key=movie:heat:1995&days=0&page=2&page_size=2')
    expect([paged.page, paged.total, paged.rows.length]).toEqual([2, 3, 1])

    // the window narrows the rows, and the title stays named without them
    const narrowed = await titleHistory('key=show:better%20call%20saul')
    expect([narrowed.title, narrowed.kind, narrowed.total]).toEqual([
      'Better Call Saul',
      'episode',
      0,
    ])
    expect(narrowed.rows).toEqual([])

    // a key nothing answers to is a stale link, not an error
    const stale = await titleHistory('key=movie:gone:1970')
    expect([stale.kind, stale.title, stale.total, stale.rows]).toEqual([null, '', 0, []])

    expect((await get('/plays/title')).statusCode).toBe(422)
    expect((await get('/plays/title?key=')).statusCode).toBe(422)
    expect((await get(`/plays/title?key=${'x'.repeat(501)}`)).statusCode).toBe(422)
  })

  it('lists what has no play in the window as never played', async () => {
    seed(db)

    const body = await neverPlayed()

    // the show's one episode was watched over a year ago, so inside the year
    // it counts as never played; the film nobody touched always does
    expect([body.summary.movies, body.summary.shows, body.summary.albums]).toEqual([1, 1, 0])
    expect(body.summary.by_quality.map((bucket) => bucket.quality)).toEqual([
      '4k',
      '1080p',
      '720p',
      'other',
    ])
    expect(body.summary.by_quality[1]).toEqual({ quality: '1080p', count: 1 })
    expect(body.summary.by_host.map((bucket) => bucket.host)).toEqual(PLEX_HOSTS)
    expect(body.summary.by_host[0]).toEqual({ host: 'meleys', count: 2 })
    expect([body.total, body.page, body.page_size]).toEqual([2, 1, 50])
    expect(body.rows.map((row) => [row.kind, row.title, row.items])).toEqual([
      ['movie', 'Never Watched', 1],
      ['show', 'Better Call Saul', 1],
    ])
    expect(body.rows[0].added_at).toMatch(/^2026-09-17/)
    expect(body.rows[0].quality).toBe('1080p')

    const allTime = await neverPlayed('?days=0&kind=movie')
    expect(allTime.summary.shows).toBe(0)
    expect(allTime.rows.map((row) => row.title)).toEqual(['Never Watched'])

    const search = await neverPlayed('?q=saul')
    expect(search.rows.map((row) => row.title)).toEqual(['Better Call Saul'])
    expect((await get(`/plays/never-played?q=${'x'.repeat(201)}`)).statusCode).toBe(422)
  })

  it('reports every Plex host and the lookback on the sync route', async () => {
    seed(db)
    vi.stubEnv('FM_PLEX_LOOKBACK_DAYS', '730')

    const body = bodyOf({ answer: await get('/plays/sync'), is: isPlaySync })

    expect(body.lookback_days).toBe(730)
    expect(body.servers.map((server) => server.host)).toEqual(PLEX_HOSTS)
    const [meleys] = body.servers
    expect([meleys.friendly_name, meleys.reachable, meleys.plays, meleys.items]).toEqual([
      'Meleys',
      true,
      4,
      3,
    ])
    expect(meleys.plex_url).toBe('http://192.168.50.2:32400')
    expect(meleys.history_synced_at).toMatch(/^2026-09-18T12:00:00/)
    expect(meleys.library_synced_at).toBeNull()
    expect(meleys.history_since).toMatch(/^2025-08-14/)
    expect(meleys.last_error).toBeNull()
    // a host no pass has reached yet is listed, unreachable and empty, rather
    // than left out: absence from the page would read as absence from the fleet
    expect(body.servers[4]).toEqual({
      host: 'vhagar',
      friendly_name: null,
      plex_url: 'https://192.168.50.6:32400',
      reachable: false,
      history_synced_at: null,
      library_synced_at: null,
      history_since: null,
      plays: 0,
      items: 0,
      last_error: null,
    })
  })

  it('answers json on every route over an empty ledger', async () => {
    // first boot: the tables exist and nothing is in them, and every route
    // still answers rather than tripping over a missing row
    expect((await overview()).totals.plays).toBe(0)
    expect(bodyOf({ answer: await get('/plays/users'), is: isPlayUsers })).toEqual({ users: [] })
    expect(bodyOf({ answer: await get('/plays/top'), is: isTopTitles })).toEqual({
      metric: 'plays',
      titles: [],
    })
    expect((await titleHistory('key=movie:heat:1995')).total).toBe(0)
    expect((await neverPlayed()).total).toBe(0)
    const sync = bodyOf({ answer: await get('/plays/sync'), is: isPlaySync })
    expect(sync.servers.every((server) => !server.reachable)).toBe(true)
  })

  // Not in the Python suite: the two corners of the port that Python gave for
  // free and the TS has to reproduce by hand.

  it('quotes an unknown host the way repr() did, whatever it holds', async () => {
    const detail = async (host: string): Promise<unknown> =>
      (await get(`/plays/users?host=${encodeURIComponent(host)}`)).json()

    expect(await detail('ghost')).toEqual({ detail: "unknown host 'ghost'" })
    // a single quote inside switches repr() to double quotes, and both inside
    // keeps single quotes and escapes the one that clashes
    expect(await detail("o'hara")).toEqual({ detail: `unknown host "o'hara"` })
    expect(await detail(`it's "x"`)).toEqual({ detail: `unknown host 'it\\'s "x"'` })
    // a backslash and anything unprintable come back as escapes
    expect(await detail('a\\b\tc\u0001  ')).toEqual({
      detail: "unknown host 'a\\\\b\\tc\\x01\\xa0\\u2028'",
    })
    // an empty host is a host nobody has, not an absent filter
    expect(await detail('')).toEqual({ detail: "unknown host ''" })
  })

  it('refuses an account id that is not an integer', async () => {
    expect((await get('/plays/users/abc/history')).statusCode).toBe(422)
    expect((await get('/plays/users/1.5/history')).statusCode).toBe(422)
  })
})
