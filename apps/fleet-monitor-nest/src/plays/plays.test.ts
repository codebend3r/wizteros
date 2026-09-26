import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { host, type Host } from '@/config.js'
import { type Connection, session } from '@/db.js'
import * as plays from '@/plays/index.js'
import {
  type Account,
  type Device,
  type Kind,
  type MediaItem,
  type PlayEntry,
  type Quality,
  section,
} from '@/probes/plex.js'
import { openTestConnection, removeTempDirs, tempDbPath } from '@/test/support.js'
import { addSeconds, epochSeconds } from '@/time.js'

const T0 = new Date(Date.UTC(2026, 8, 18, 12, 0, 0))
const NOW = epochSeconds(T0)
const DAY = 86_400

const HOSTS: readonly string[] = ['meleys', 'vermithor', 'caraxes', 'syrax', 'vhagar']

const plexHost = ({ name, plexUrl }: { name: string; plexUrl: string }): Host =>
  host({ name, ip: '', has_gpu: false, docker_url: '', plex_url: plexUrl })

const at = (daysAgo: number): number => NOW - Math.trunc(daysAgo * DAY)

const utc = (epoch: number): Date => new Date(epoch * 1000)

/** The value a lookup found, or a failed test when it found nothing. */
const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('expected a value, found none')
  }
  return value
}

type ItemOptions = {
  ratingKey: string
  kind?: Kind
  title?: string
  year?: number | null
  quality?: Quality | null
  parentRatingKey?: string | null
  parentTitle?: string | null
  grandparentRatingKey?: string | null
  grandparentTitle?: string | null
  index?: number | null
  parentIndex?: number | null
  durationMs?: number | null
  sectionId?: string | null
  addedAt?: number | null
}

const item = ({
  ratingKey,
  kind = 'movie',
  title = 'Heat',
  year = 1995,
  quality = '1080p',
  parentRatingKey = null,
  parentTitle = null,
  grandparentRatingKey = null,
  grandparentTitle = null,
  index = null,
  parentIndex = null,
  durationMs = 6_000_000,
  sectionId = '8',
  addedAt = at(30),
}: ItemOptions): MediaItem => ({
  rating_key: ratingKey,
  kind,
  title,
  parent_rating_key: parentRatingKey,
  parent_title: parentTitle,
  parent_index: parentIndex,
  grandparent_rating_key: grandparentRatingKey,
  grandparent_title: grandparentTitle,
  index,
  year,
  section_id: sectionId,
  duration_ms: durationMs,
  video_resolution: null,
  width: null,
  height: null,
  quality,
  thumb: `/library/metadata/${ratingKey}/thumb/1`,
  added_at: addedAt,
})

const episode = ({
  ratingKey,
  showKey,
  show,
  index,
  ...rest
}: {
  ratingKey: string
  showKey: string
  show: string
  index: number
} & Pick<ItemOptions, 'quality' | 'addedAt' | 'durationMs'>): MediaItem =>
  item({
    ratingKey,
    kind: 'episode',
    title: `${show} ${index}`,
    year: null,
    parentRatingKey: `${showKey}s1`,
    parentTitle: 'Season 1',
    parentIndex: 1,
    grandparentRatingKey: showKey,
    grandparentTitle: show,
    index,
    sectionId: '6',
    ...rest,
  })

const track = ({
  ratingKey,
  albumKey,
  album,
  artist,
  index,
}: {
  ratingKey: string
  albumKey: string
  album: string
  artist: string
  index: number
}): MediaItem =>
  item({
    ratingKey,
    kind: 'track',
    title: `${album} ${index}`,
    year: null,
    quality: null,
    parentRatingKey: albumKey,
    parentTitle: album,
    grandparentRatingKey: `${albumKey}a`,
    grandparentTitle: artist,
    index,
    sectionId: '21',
    durationMs: 240_000,
  })

const play = ({
  historyId,
  ratingKey,
  kind = 'movie',
  accountId = 1,
  daysAgo = 1,
  title = 'played',
  deviceId = 460,
  sectionId = '8',
}: {
  historyId: number
  ratingKey: string
  kind?: Kind
  accountId?: number
  daysAgo?: number
  title?: string
  deviceId?: number | null
  sectionId?: string | null
}): PlayEntry => ({
  history_id: historyId,
  rating_key: ratingKey,
  kind,
  title,
  section_id: sectionId,
  account_id: accountId,
  device_id: deviceId,
  viewed_at: at(daysAgo),
})

/**
 * Two hosts, three viewers, a little of everything.
 *
 * meleys: Heat (1080p) played by 1 twice and by 7 once; Paddington 2 (4k)
 * played by 7; Better Call Saul with two episodes, viewer 1 watched episode 1
 * (4k) twice and episode 2 once, viewer 9 watched episode 1 once; a Kid A
 * album with one track played by 7; an sd film played by 1.
 *
 * syrax: Heat again (720p) played by 9 a hundred days ago; a never-played film
 * in 4k and one in 1080p; a never-played show; a never-played album; and a
 * retired film nobody could play any more.
 */
const seed = (db: Connection): Connection => {
  plays.upsertServer({
    connection: db,
    host: 'meleys',
    info: { friendly_name: 'Meleys', machine_id: 'm', version: '1.43.4' },
  })
  plays.upsertServer({
    connection: db,
    host: 'syrax',
    info: { friendly_name: 'Syrax', machine_id: 's', version: '1.43.4' },
  })
  const meleysAccounts: readonly Account[] = [
    { account_id: 1, name: 'cj', thumb: 'https://plex.tv/1' },
    { account_id: 7, name: '', thumb: null },
    { account_id: 9, name: 'freenow', thumb: null },
  ]
  plays.upsertAccounts({ connection: db, host: 'meleys', accounts: meleysAccounts })
  plays.upsertAccounts({
    connection: db,
    host: 'syrax',
    accounts: [{ account_id: 7, name: 'danny', thumb: null }],
  })
  const chrome: Device = {
    device_id: 460,
    name: 'Chrome',
    platform: 'Chrome',
    client_identifier: 'c',
  }
  plays.upsertDevices({ connection: db, host: 'meleys', devices: [chrome] })
  plays.upsertSections({
    connection: db,
    host: 'meleys',
    sections: [
      section({ section_id: '8', title: '04. Movies', kind: 'movie' }),
      section({ section_id: '6', title: '06. TV Shows', kind: 'episode' }),
      section({ section_id: '21', title: '20. Music', kind: 'track' }),
    ],
  })
  plays.upsertSections({
    connection: db,
    host: 'syrax',
    sections: [
      section({ section_id: '3', title: 'Films', kind: 'movie' }),
      section({ section_id: '6', title: 'Shows', kind: 'episode' }),
      section({ section_id: '21', title: 'Music', kind: 'track' }),
    ],
  })
  plays.upsertItems({
    connection: db,
    host: 'meleys',
    items: [
      item({ ratingKey: '100', title: 'Heat', year: 1995, quality: '1080p' }),
      item({
        ratingKey: '101',
        title: 'Paddington 2',
        year: 2017,
        quality: '4k',
        durationMs: 9_000_000,
      }),
      item({ ratingKey: '102', title: 'Old Film', year: 1950, quality: 'sd' }),
      episode({
        ratingKey: '201',
        showKey: '200',
        show: 'Better Call Saul',
        index: 1,
        quality: '4k',
      }),
      episode({
        ratingKey: '202',
        showKey: '200',
        show: 'Better Call Saul',
        index: 2,
        quality: '1080p',
      }),
      track({ ratingKey: '301', albumKey: '300', album: 'Kid A', artist: 'Radiohead', index: 1 }),
    ],
    seenAt: T0,
  })
  plays.upsertItems({
    connection: db,
    host: 'syrax',
    items: [
      item({
        ratingKey: '900',
        title: 'Heat',
        year: 1995,
        quality: '720p',
        sectionId: '3',
        addedAt: at(2),
      }),
      item({
        ratingKey: '901',
        title: 'Never Watched',
        year: 2020,
        quality: '4k',
        sectionId: '3',
        addedAt: at(1),
      }),
      item({
        ratingKey: '902',
        title: 'Also Never',
        year: 2021,
        quality: '1080p',
        sectionId: '3',
        addedAt: null,
      }),
      episode({
        ratingKey: '911',
        showKey: '910',
        show: 'Untouched Show',
        index: 1,
        quality: '720p',
        addedAt: at(5),
      }),
      episode({
        ratingKey: '912',
        showKey: '910',
        show: 'Untouched Show',
        index: 2,
        quality: '1080p',
        addedAt: at(4),
      }),
      track({
        ratingKey: '921',
        albumKey: '920',
        album: 'Silent Album',
        artist: 'Nobody',
        index: 1,
      }),
    ],
    seenAt: T0,
  })
  plays.upsertItems({
    connection: db,
    host: 'syrax',
    items: [item({ ratingKey: '903', title: 'Retired Film', year: 1999, sectionId: '3' })],
    seenAt: addSeconds({ at: T0, seconds: -2 * DAY }),
  })
  plays.retireUnseenItems({ connection: db, host: 'syrax', seenBefore: T0 })
  plays.insertPlays({
    connection: db,
    host: 'meleys',
    plays: [
      play({ historyId: 1, ratingKey: '100', accountId: 1, daysAgo: 1 }),
      play({ historyId: 2, ratingKey: '100', accountId: 1, daysAgo: 40 }),
      play({ historyId: 3, ratingKey: '100', accountId: 7, daysAgo: 2 }),
      play({ historyId: 4, ratingKey: '101', accountId: 7, daysAgo: 3 }),
      play({
        historyId: 5,
        ratingKey: '201',
        kind: 'episode',
        accountId: 1,
        daysAgo: 4,
        sectionId: '6',
      }),
      play({
        historyId: 6,
        ratingKey: '201',
        kind: 'episode',
        accountId: 1,
        daysAgo: 5,
        sectionId: '6',
      }),
      play({
        historyId: 7,
        ratingKey: '202',
        kind: 'episode',
        accountId: 1,
        daysAgo: 6,
        sectionId: '6',
      }),
      play({
        historyId: 8,
        ratingKey: '201',
        kind: 'episode',
        accountId: 9,
        daysAgo: 7,
        sectionId: '6',
      }),
      play({
        historyId: 9,
        ratingKey: '301',
        kind: 'track',
        accountId: 7,
        daysAgo: 8,
        sectionId: '21',
        deviceId: null,
      }),
      play({ historyId: 10, ratingKey: '102', accountId: 1, daysAgo: 9 }),
    ],
  })
  plays.insertPlays({
    connection: db,
    host: 'syrax',
    plays: [play({ historyId: 1, ratingKey: '900', accountId: 9, daysAgo: 100, sectionId: '3' })],
  })
  return db
}

/**
 * One column of a query, as a list, for the tests that assert on rows the
 * store deleted rather than on anything it returns.
 */
const column = ({
  connection,
  sql,
  params = [],
}: {
  connection: Connection
  sql: string
  params?: readonly (string | number | null)[]
}): unknown[] =>
  connection
    .prepare(sql)
    .raw(true)
    .all(...params)
    .map((row) => (Array.isArray(row) ? row[0] : undefined))

const never = ({
  connection,
  filters = plays.filters(),
  page = 1,
  pageSize = 50,
  q = '',
  now = T0,
}: {
  connection: Connection
  filters?: plays.Filters
  page?: number
  pageSize?: number
  q?: string
  now?: Date
}): plays.NeverPlayedPage =>
  plays.neverPlayed({ connection, filters, hosts: HOSTS, page, pageSize, q, now })

const everything = plays.filters()

describe('plays', () => {
  // The pytest `db` fixture: one initialized connection standing in for a
  // single session across the whole test.
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [plays.initDb] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  describe('writes', () => {
    it('initialises the db idempotently', () => {
      plays.initDb(db)
      plays.initDb(db)

      expect(plays.historyCursor({ connection: db, host: 'meleys' })).toBeNull()
    })

    it('counts only new rows on insert and ignores a replay', () => {
      const first = plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 1, ratingKey: '100' }), play({ historyId: 2, ratingKey: '101' })],
      })
      const again = plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 2, ratingKey: '101' }), play({ historyId: 3, ratingKey: '102' })],
      })

      expect(first).toBe(2)
      expect(again).toBe(1)
      // the same history id on another host is another play: ids are per server
      expect(
        plays.insertPlays({
          connection: db,
          host: 'syrax',
          plays: [play({ historyId: 1, ratingKey: '100' })],
        }),
      ).toBe(1)
      expect(plays.insertPlays({ connection: db, host: 'syrax', plays: [] })).toBe(0)
    })

    it('keeps the history cursor per host and through a server upsert', () => {
      plays.setHistoryCursor({ connection: db, host: 'meleys', cursor: 1_700_000_000 })
      plays.upsertServer({
        connection: db,
        host: 'meleys',
        info: { friendly_name: 'Meleys', machine_id: 'm', version: '1' },
      })

      expect(plays.historyCursor({ connection: db, host: 'meleys' })).toBe(1_700_000_000)
      expect(plays.historyCursor({ connection: db, host: 'syrax' })).toBeNull()
    })

    it('records a history outcome even before the server was ever identified', () => {
      // the very first pass can fail at GET / itself; the failure still has to
      // be visible on /plays/sync, so the row is created here rather than assumed
      plays.markHistory({ connection: db, host: 'vhagar', at: T0, ok: false, error: 'refused' })

      const status = plays.syncStatus({
        connection: db,
        hosts: [plexHost({ name: 'vhagar', plexUrl: 'https://192.168.50.6:32400' })],
      })
      expect(status[0].reachable).toBe(false)
      expect(status[0].last_error).toBe('refused')
      expect(status[0].history_synced_at).toEqual(T0)
      expect(status[0].friendly_name).toBeNull()
    })

    it('updates an existing item row and brings it back to present', () => {
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '100', quality: '720p' })],
        seenAt: addSeconds({ at: T0, seconds: -DAY }),
      })
      plays.retireUnseenItems({ connection: db, host: 'meleys', seenBefore: T0 })
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '100', quality: '4k' })],
        seenAt: T0,
      })

      const row = db
        .prepare("SELECT quality, present, seen_at FROM plex_items WHERE host = 'meleys'")
        .get()
      // seen_at is T0.isoformat(), the exact text the Python collector wrote
      expect(row).toEqual({ quality: '4k', present: 1, seen_at: '2026-09-18T12:00:00+00:00' })
    })

    it('retires only what the inventory run did not see', () => {
      const hourBefore = addSeconds({ at: T0, seconds: -3600 })
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '1' }), item({ ratingKey: '2' })],
        seenAt: hourBefore,
      })
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '2' })],
        seenAt: T0,
      })
      plays.upsertItems({
        connection: db,
        host: 'syrax',
        items: [item({ ratingKey: '3' })],
        seenAt: hourBefore,
      })

      const retired = plays.retireUnseenItems({ connection: db, host: 'meleys', seenBefore: T0 })

      expect(retired).toBe(1)
      const present = db
        .prepare('SELECT host, rating_key, present FROM plex_items ORDER BY host, rating_key')
        .all()
      expect(present).toEqual([
        { host: 'meleys', rating_key: '1', present: 0 },
        { host: 'meleys', rating_key: '2', present: 1 },
        { host: 'syrax', rating_key: '3', present: 1 },
      ])
    })

    it('names played items with no row as missing and stubs silence them', () => {
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey: '100', title: 'Known' }),
          play({ historyId: 2, ratingKey: '555', title: 'Gone film' }),
          play({ historyId: 3, ratingKey: '555', title: 'Gone film' }),
          play({ historyId: 4, ratingKey: '556', kind: 'episode', title: 'Gone ep' }),
        ],
      })
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '100' })],
        seenAt: T0,
      })

      expect(plays.missingItemKeys({ connection: db, host: 'meleys', limit: 10 })).toEqual([
        '555',
        '556',
      ])
      expect(plays.missingItemKeys({ connection: db, host: 'meleys', limit: 1 })).toEqual(['555'])

      plays.stubMissingItems({ connection: db, host: 'meleys', keys: ['555', '556'], seenAt: T0 })

      expect(plays.missingItemKeys({ connection: db, host: 'meleys', limit: 10 })).toEqual([])
      const stub = db
        .prepare("SELECT kind, title, present, quality FROM plex_items WHERE rating_key = '556'")
        .get()
      expect(stub).toEqual({ kind: 'episode', title: 'Gone ep', present: 0, quality: null })
    })

    it('replaces account and device names in place', () => {
      plays.upsertAccounts({
        connection: db,
        host: 'meleys',
        accounts: [{ account_id: 1, name: 'old', thumb: null }],
      })
      plays.upsertAccounts({
        connection: db,
        host: 'meleys',
        accounts: [{ account_id: 1, name: 'new', thumb: 't' }],
      })
      plays.upsertDevices({
        connection: db,
        host: 'meleys',
        devices: [{ device_id: 1, name: 'TV', platform: null, client_identifier: null }],
      })
      plays.upsertDevices({
        connection: db,
        host: 'meleys',
        devices: [{ device_id: 1, name: 'Living room', platform: 'tvOS', client_identifier: 'x' }],
      })

      expect(db.prepare('SELECT name, thumb FROM plex_accounts').raw(true).get()).toEqual([
        'new',
        't',
      ])
      expect(db.prepare('SELECT name, platform FROM plex_devices').raw(true).get()).toEqual([
        'Living room',
        'tvOS',
      ])
    })
  })

  describe('overview', () => {
    it('totals and zero-fills its breakdowns', () => {
      const view = plays.overview({
        connection: seed(db),
        filters: everything,
        hosts: HOSTS,
        now: T0,
      })

      // watch time is the played items' own durations: eleven completed plays
      expect(view.totals).toEqual({ plays: 11, viewers: 3, titles: 5, watch_ms: 63_240_000 })
      expect(view.by_kind.map((row) => [row.kind, row.plays])).toEqual([
        ['movie', 6],
        ['episode', 4],
        ['track', 1],
      ])
      // video plays only: the one track is in no bucket; the sd film is "other"
      expect(view.by_quality.map((row) => [row.quality, row.plays])).toEqual([
        ['4k', 4],
        ['1080p', 4],
        ['720p', 1],
        ['other', 1],
      ])
      // every Plex host in the order handed in, zero-filled, position is colour
      expect(view.by_host.map((row) => [row.host, row.friendly_name, row.plays])).toEqual([
        ['meleys', 'Meleys', 10],
        ['vermithor', null, 0],
        ['caraxes', null, 0],
        ['syrax', 'Syrax', 1],
        ['vhagar', null, 0],
      ])
    })

    it('names top viewers by the first non-empty name across hosts', () => {
      const view = plays.overview({
        connection: seed(db),
        filters: everything,
        hosts: HOSTS,
        now: T0,
      })

      // 7 is nameless on meleys and "danny" on syrax; 9 is named on meleys only
      expect(view.top_viewers.map((row) => [row.account_id, row.name, row.plays])).toEqual([
        [1, 'cj', 6],
        [7, 'danny', 3],
        [9, 'freenow', 2],
      ])
    })

    it('ranks the five most played groups as top titles, newest first on a tie', () => {
      const view = plays.overview({
        connection: seed(db),
        filters: everything,
        hosts: HOSTS,
        now: T0,
      })

      expect(view.top_titles.map((row) => [row.title, row.plays])).toEqual([
        ['Heat', 4],
        ['Better Call Saul', 4],
        ['Paddington 2', 1],
        ['Kid A', 1],
        ['Old Film', 1],
      ])
    })

    it.each<[number, plays.Bucket]>([
      [7, 'day'],
      [31, 'day'],
      [32, 'week'],
      [180, 'week'],
      [181, 'month'],
      [365, 'month'],
    ])('buckets the timeline of a %i day window by %s', (days, bucket) => {
      const filters = plays.filters({ since: NOW - days * DAY })

      expect(
        plays.overview({ connection: seed(db), filters, hosts: HOSTS, now: T0 }).timeline.bucket,
      ).toBe(bucket)
    })

    it('buckets an all-time timeline from the earliest play', () => {
      // the oldest stored play is 100 days back, so the window is a week one
      const view = plays.overview({
        connection: seed(db),
        filters: everything,
        hosts: HOSTS,
        now: T0,
      })

      expect(view.timeline.bucket).toBe('week')
      expect(view.timeline.points.reduce((sum, point) => sum + point.plays, 0)).toBe(11)
      view.timeline.points.forEach((point) =>
        expect(Object.values(point.hosts).reduce((sum, count) => sum + count, 0)).toBe(point.plays),
      )
      const starts = view.timeline.points.map((point) => point.start)
      expect(starts).toEqual(starts.toSorted())
    })

    it('names the local date on day points and splits them by host', () => {
      const view = plays.overview({
        connection: seed(db),
        filters: plays.filters({ since: at(3) }),
        hosts: HOSTS,
        now: T0,
      })

      expect(view.timeline.bucket).toBe('day')
      expect(view.timeline.points.map((point) => point.plays)).toEqual([1, 1, 1])
      view.timeline.points.forEach((point) => {
        expect(point.hosts).toEqual({ meleys: 1 })
        expect(point.start).toHaveLength(10)
        expect(point.start[4]).toBe('-')
      })
    })

    it('answers an empty ledger with all zeros rather than an error', () => {
      const view = plays.overview({
        connection: db,
        filters: everything,
        hosts: ['meleys'],
        now: T0,
      })

      expect(view.totals).toEqual({ plays: 0, viewers: 0, titles: 0, watch_ms: 0 })
      expect(view.by_kind.map((row) => row.plays)).toEqual([0, 0, 0])
      expect(view.by_quality.map((row) => row.plays)).toEqual([0, 0, 0, 0])
      expect(view.by_host.map((row) => [row.host, row.plays])).toEqual([['meleys', 0]])
      expect(view.timeline.points).toEqual([])
      expect(view.timeline.bucket).toBe('month')
      expect(view.top_viewers).toEqual([])
      expect(view.top_titles).toEqual([])
    })
  })

  describe('filters', () => {
    it('holds the window inclusive on its lower edge', () => {
      seed(db)
      const exact = plays.filters({ since: at(40) })
      const justAfter = plays.filters({ since: at(40) + 1 })

      expect(
        plays.overview({ connection: db, filters: exact, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(10)
      expect(
        plays.overview({ connection: db, filters: justAfter, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(9)
    })

    it('applies a quality filter to video only', () => {
      seed(db)
      const only4k = plays.overview({
        connection: db,
        filters: plays.filters({ quality: '4k' }),
        hosts: HOSTS,
        now: T0,
      })
      const other = plays.overview({
        connection: db,
        filters: plays.filters({ quality: 'other' }),
        hosts: HOSTS,
        now: T0,
      })

      expect(only4k.totals.plays).toBe(4)
      expect(only4k.by_kind.map((row) => [row.kind, row.plays])).toEqual([
        ['movie', 1],
        ['episode', 3],
        ['track', 0],
      ])
      // sd and unknown video, never a track
      expect(other.totals.plays).toBe(1)
      expect(other.by_kind.map((row) => [row.kind, row.plays])).toEqual([
        ['movie', 1],
        ['episode', 0],
        ['track', 0],
      ])
      expect(
        plays.overview({
          connection: db,
          filters: plays.filters({ kind: 'track', quality: 'other' }),
          hosts: HOSTS,
          now: T0,
        }).totals.plays,
      ).toBe(0)
    })

    it('counts a play whose item is gone as other quality', () => {
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 1, ratingKey: '555', title: 'Deleted film' })],
      })

      const view = plays.overview({
        connection: db,
        filters: plays.filters({ quality: 'other' }),
        hosts: ['meleys'],
        now: T0,
      })

      expect(view.totals.plays).toBe(1)
      expect(view.top_titles[0].title).toBe('Deleted film')
      expect(view.top_titles[0].quality).toBeNull()
    })

    it('narrows every view by host and kind', () => {
      seed(db)
      const syrax = plays.filters({ host: 'syrax' })
      const tracks = plays.filters({ kind: 'track' })

      expect(
        plays.overview({ connection: db, filters: syrax, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(1)
      expect(plays.users({ connection: db, filters: syrax })[0].account_id).toBe(9)
      expect(
        plays
          .topTitles({ connection: db, filters: tracks, metric: 'plays', limit: 5 })
          .map((row) => row.title),
      ).toEqual(['Kid A'])
    })
  })

  describe('users', () => {
    it('ranks users by plays with their kinds, hosts and favourite', () => {
      const users = plays.users({ connection: seed(db), filters: everything })

      expect(
        users.map((u) => [u.account_id, u.name, u.plays, u.movies, u.episodes, u.tracks]),
      ).toEqual([
        [1, 'cj', 6, 3, 3, 0],
        [7, 'danny', 3, 2, 0, 1],
        [9, 'freenow', 2, 1, 1, 0],
      ])
      expect(users[0].thumb).toBe('https://plex.tv/1')
      expect(users[0].hosts).toEqual(['meleys'])
      expect(users[2].hosts).toEqual(['meleys', 'syrax'])
      expect(users[0].last_viewed_at).toEqual(utc(at(1)))
      // the group with the most plays for that viewer, alphabetical on a tie
      expect(users[0].top_title).toBe('Better Call Saul')
      expect(users[1].top_title).toBe('Heat')
    })

    it('keeps the id as the name of a viewer nobody named', () => {
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 1, ratingKey: '100', accountId: 424242 })],
      })

      expect(plays.users({ connection: db, filters: everything })[0].name).toBe('account 424242')
    })
  })

  describe('user history', () => {
    it('lists newest first with titles, devices and libraries joined', () => {
      const page = plays.userHistory({
        connection: seed(db),
        filters: everything,
        accountId: 1,
        page: 1,
        pageSize: 3,
      })

      expect(page.total).toBe(6)
      expect(page.name).toBe('cj')
      expect(page.account_id).toBe(1)
      expect(page.rows.map((row) => row.title)).toEqual([
        'Heat',
        'Better Call Saul 1',
        'Better Call Saul 1',
      ])
      const heat = page.rows[0]
      expect(heat.viewed_at).toEqual(utc(at(1)))
      expect(heat.kind).toBe('movie')
      expect(heat.host).toBe('meleys')
      expect(heat.quality).toBe('1080p')
      expect(heat.device).toBe('Chrome')
      expect(heat.library).toBe('04. Movies')
      expect(heat.year).toBe(1995)
      expect(heat.duration_ms).toBe(6_000_000)
      const episodeRow = page.rows[1]
      expect([
        episodeRow.grandparent_title,
        episodeRow.parent_title,
        episodeRow.parent_index,
        episodeRow.index,
      ]).toEqual(['Better Call Saul', 'Season 1', 1, 1])
    })

    it('pages and honours the filters', () => {
      seed(db)
      const second = plays.userHistory({
        connection: db,
        filters: everything,
        accountId: 1,
        page: 2,
        pageSize: 3,
      })
      const movies = plays.userHistory({
        connection: db,
        filters: plays.filters({ kind: 'movie' }),
        accountId: 1,
        page: 1,
        pageSize: 50,
      })
      const nobody = plays.userHistory({
        connection: db,
        filters: everything,
        accountId: 4242,
        page: 1,
        pageSize: 50,
      })

      expect(second.rows.map((row) => row.title)).toEqual([
        'Better Call Saul 2',
        'Old Film',
        'Heat',
      ])
      expect(second.page).toBe(2)
      expect(second.page_size).toBe(3)
      expect(movies.rows.map((row) => row.title)).toEqual(['Heat', 'Old Film', 'Heat'])
      expect(movies.total).toBe(3)
      expect(nobody.total).toBe(0)
      expect(nobody.rows).toEqual([])
      expect(nobody.name).toBe('account 4242')
    })

    it('keeps a play whose item is gone', () => {
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 1, ratingKey: '555', title: 'Deleted film', deviceId: null })],
      })

      const row = plays.userHistory({
        connection: db,
        filters: everything,
        accountId: 1,
        page: 1,
        pageSize: 5,
      }).rows[0]

      expect(row.title).toBe('Deleted film')
      expect(row.quality).toBeNull()
      expect(row.device).toBeNull()
      expect(row.library).toBeNull()
    })
  })

  describe('title history', () => {
    it('gathers one title across hosts with who finished it', () => {
      seed(db)
      const page = plays.titleHistory({
        connection: db,
        filters: everything,
        key: 'movie:heat:1995',
        page: 1,
        pageSize: 50,
      })

      expect([page.kind, page.title, page.year, page.context]).toEqual([
        'movie',
        'Heat',
        1995,
        null,
      ])
      // the same film on two servers is one title: three viewers, two copies,
      // and the best quality either copy was watched at
      expect([page.total, page.viewers, page.items, page.rewatches]).toEqual([4, 3, 2, 1])
      expect(page.hosts).toEqual(['meleys', 'syrax'])
      expect(page.quality).toBe('1080p')
      expect(page.first_viewed_at).toEqual(utc(at(100)))
      expect(page.last_viewed_at).toEqual(utc(at(1)))
      expect(page.rows.map((row) => [row.viewer, row.host])).toEqual([
        ['cj', 'meleys'],
        ['danny', 'meleys'],
        ['cj', 'meleys'],
        ['freenow', 'syrax'],
      ])
      const newest = page.rows[0]
      expect([newest.account_id, newest.quality, newest.device, newest.library]).toEqual([
        1,
        '1080p',
        'Chrome',
        '04. Movies',
      ])

      // a show gathers its episodes, and moving on to the next one is no rewatch
      const show = plays.titleHistory({
        connection: db,
        filters: everything,
        key: 'show:better call saul',
        page: 1,
        pageSize: 50,
      })
      expect([show.kind, show.title, show.total, show.items, show.rewatches]).toEqual([
        'episode',
        'Better Call Saul',
        4,
        2,
        1,
      ])
      expect(show.rows.map((row) => [row.parent_index, row.index])).toEqual([
        [1, 1],
        [1, 1],
        [1, 2],
        [1, 1],
      ])

      const album = plays.titleHistory({
        connection: db,
        filters: everything,
        key: 'album:kid a:radiohead',
        page: 1,
        pageSize: 50,
      })
      expect([album.kind, album.title, album.context, album.total]).toEqual([
        'track',
        'Kid A',
        'Radiohead',
        1,
      ])
    })

    it('pages and stays named under a filter that holds no play', () => {
      seed(db)
      const second = plays.titleHistory({
        connection: db,
        filters: everything,
        key: 'movie:heat:1995',
        page: 2,
        pageSize: 3,
      })
      expect([second.page, second.page_size, second.total]).toEqual([2, 3, 4])
      expect(second.rows.map((row) => row.host)).toEqual(['syrax'])

      const windowed = plays.titleHistory({
        connection: db,
        filters: plays.filters({ since: at(7) }),
        key: 'movie:heat:1995',
        page: 1,
        pageSize: 50,
      })
      expect([windowed.total, windowed.viewers, windowed.rewatches]).toEqual([2, 2, 0])
      expect(windowed.hosts).toEqual(['meleys'])

      // a filter the title has no play under still answers with the title: the
      // page holds only the key, and a blank heading would read as a deletion
      const empty = plays.titleHistory({
        connection: db,
        filters: plays.filters({ host: 'vhagar' }),
        key: 'movie:heat:1995',
        page: 1,
        pageSize: 50,
      })
      expect([empty.kind, empty.title, empty.year, empty.quality]).toEqual([
        'movie',
        'Heat',
        1995,
        '1080p',
      ])
      expect([empty.total, empty.viewers, empty.rewatches, empty.rows]).toEqual([0, 0, 0, []])
      expect([empty.hosts, empty.first_viewed_at, empty.last_viewed_at]).toEqual([[], null, null])
    })

    it('answers a key nothing in the ledger carries', () => {
      const stale = plays.titleHistory({
        connection: seed(db),
        filters: everything,
        key: 'movie:gone:1970',
        page: 1,
        pageSize: 50,
      })

      expect([stale.key, stale.kind, stale.title, stale.total, stale.rows]).toEqual([
        'movie:gone:1970',
        null,
        '',
        0,
        [],
      ])
    })

    it('gives user history rows the key their title is ranked under', () => {
      seed(db)
      const rows = plays.userHistory({
        connection: db,
        filters: everything,
        accountId: 1,
        page: 1,
        pageSize: 50,
      }).rows
      const ranked = new Set(
        plays
          .topTitles({ connection: db, filters: everything, metric: 'plays', limit: 50 })
          .map((title) => title.key),
      )

      // the contract the page links on: every row names a title the rankings
      // know, so a play can be opened as that title's own history
      expect(rows.map((row) => row.group_key).filter((key) => !ranked.has(key))).toEqual([])
      expect(rows[0].group_key).toBe('movie:heat:1995')
    })
  })

  describe('one viewing, logged twice', () => {
    const SECONDS = 1 / DAY

    /** One item and two completions of it by one viewer, `gapSeconds` apart. */
    const twice = ({
      ratingKey,
      media,
      kind,
      gapSeconds,
      accountId = 1,
      daysAgo = 1.0,
    }: {
      ratingKey: string
      media: MediaItem
      kind: Kind
      gapSeconds: number
      accountId?: number
      daysAgo?: number
    }): void => {
      plays.upsertItems({ connection: db, host: 'meleys', items: [media], seenAt: T0 })
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey, kind, accountId, daysAgo }),
          play({
            historyId: 2,
            ratingKey,
            kind,
            accountId,
            daysAgo: daysAgo - gapSeconds * SECONDS,
          }),
        ],
      })
    }

    it('counts a viewing Plex logged twice inside one runtime once everywhere', () => {
      // Plex writes a history row each time an item is marked watched, and some
      // clients mark one viewing twice: at the watched threshold, then again at
      // the stop. A 44 minute episode cannot be finished twice in a minute.
      twice({
        ratingKey: '201',
        media: episode({
          ratingKey: '201',
          showKey: '200',
          show: 'Better Call Saul',
          index: 1,
          durationMs: 2_677_024,
        }),
        kind: 'episode',
        gapSeconds: 60,
      })
      plays.upsertSections({
        connection: db,
        host: 'meleys',
        sections: [section({ section_id: '6', title: 'TV', kind: 'episode' })],
      })

      const summary = plays.overview({ connection: db, filters: everything, hosts: HOSTS, now: T0 })
      expect(summary.totals.plays).toBe(1)
      expect(summary.by_kind[1].plays).toBe(1)
      expect(summary.timeline.points.reduce((sum, point) => sum + point.plays, 0)).toBe(1)
      const title = plays.topTitles({
        connection: db,
        filters: everything,
        metric: 'plays',
        limit: 5,
      })[0]
      expect([title.plays, title.rewatches, title.top_rewatcher]).toEqual([1, 0, null])
      expect(
        plays.topTitles({ connection: db, filters: everything, metric: 'rewatches', limit: 5 }),
      ).toEqual([])
      expect(plays.users({ connection: db, filters: everything })[0].plays).toBe(1)
      const history = plays.userHistory({
        connection: db,
        filters: everything,
        accountId: 1,
        page: 1,
        pageSize: 10,
      })
      expect(history.total).toBe(1)
      // the row kept is the first, the moment the item became watched
      expect(history.rows[0].viewed_at).toEqual(utc(at(1)))
      const byTitle = plays.titleHistory({
        connection: db,
        filters: everything,
        key: 'show:better call saul',
        page: 1,
        pageSize: 10,
      })
      expect([byTitle.total, byTitle.rewatches, byTitle.rows.length]).toEqual([1, 0, 1])
      expect(
        plays.syncStatus({
          connection: db,
          hosts: [plexHost({ name: 'meleys', plexUrl: 'http://meleys:32400' })],
        })[0].plays,
      ).toBe(1)

      // finishing it again the next day is a real rewatch, and still counts
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 3, ratingKey: '201', kind: 'episode', daysAgo: 0 })],
      })
      const again = plays.topTitles({
        connection: db,
        filters: everything,
        metric: 'plays',
        limit: 5,
      })[0]
      expect([again.plays, again.rewatches]).toEqual([2, 1])
    })

    it('counts a repeat no faster than the runtime as a real play', () => {
      // a four minute track on repeat finishes again five minutes later
      twice({
        ratingKey: '301',
        media: track({
          ratingKey: '301',
          albumKey: '300',
          album: 'Kid A',
          artist: 'Radiohead',
          index: 1,
        }),
        kind: 'track',
        gapSeconds: 300,
      })

      expect(
        plays.overview({ connection: db, filters: everything, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(2)
      expect(
        plays.topTitles({ connection: db, filters: everything, metric: 'plays', limit: 5 })[0]
          .rewatches,
      ).toBe(1)
    })

    it('does not take a second completion by another viewer for a duplicate', () => {
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '100', title: 'Heat', year: 1995 })],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey: '100', accountId: 1, daysAgo: 1 }),
          play({ historyId: 2, ratingKey: '100', accountId: 7, daysAgo: 1 - 30 * SECONDS }),
        ],
      })

      expect(
        plays.overview({ connection: db, filters: everything, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(2)
    })

    it('never collapses a play whose runtime is unknown', () => {
      // the item is gone from the library, so nothing says how long it was, and
      // a guess would delete a play a viewer may really have made
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey: '555', title: 'Deleted film', daysAgo: 1 }),
          play({
            historyId: 2,
            ratingKey: '555',
            title: 'Deleted film',
            daysAgo: 1 - 30 * SECONDS,
          }),
        ],
      })

      expect(
        plays.overview({ connection: db, filters: everything, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(2)
    })

    it('counts a chain of markings inside one runtime as one play', () => {
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '100', title: 'Heat', year: 1995 })],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [
          play({ historyId: 1, ratingKey: '100', daysAgo: 1 }),
          play({ historyId: 2, ratingKey: '100', daysAgo: 1 - 40 * SECONDS }),
          play({ historyId: 3, ratingKey: '100', daysAgo: 1 - 3_000 * SECONDS }),
        ],
      })

      expect(
        plays.overview({ connection: db, filters: everything, hosts: HOSTS, now: T0 }).totals.plays,
      ).toBe(1)
    })
  })

  describe('top titles', () => {
    it('groups a film across hosts and counts rewatches per viewer per item', () => {
      const titles = plays.topTitles({
        connection: seed(db),
        filters: everything,
        metric: 'plays',
        limit: 10,
      })
      const heat = must(titles.find((row) => row.title === 'Heat'))

      expect(heat.kind).toBe('movie')
      expect(heat.year).toBe(1995)
      expect(heat.context).toBeNull()
      expect(heat.plays).toBe(4)
      expect(heat.viewers).toBe(3)
      expect(heat.items).toBe(2)
      expect(heat.hosts).toEqual(['meleys', 'syrax'])
      // viewer 1 watched it twice: one rewatch, and the best played copy is 1080p
      expect(heat.rewatches).toBe(1)
      expect(heat.quality).toBe('1080p')
      expect(heat.top_rewatcher).toEqual({ account_id: 1, name: 'cj', plays: 2 })
      expect(heat.last_viewed_at).toEqual(utc(at(1)))
      expect(heat.key).toBe('movie:heat:1995')
      expect(heat.thumb).not.toBeNull()
    })

    it('folds episodes into their show', () => {
      const show = plays.topTitles({
        connection: seed(db),
        filters: plays.filters({ kind: 'episode' }),
        metric: 'plays',
        limit: 5,
      })[0]

      expect(show.title).toBe('Better Call Saul')
      expect(show.context).toBeNull()
      expect(show.year).toBeNull()
      expect(show.plays).toBe(4)
      expect(show.viewers).toBe(2)
      expect(show.items).toBe(2)
      // viewer 1 saw episode 1 twice: one rewatch; ten different episodes would be none
      expect(show.rewatches).toBe(1)
      expect(show.top_rewatcher).toEqual({ account_id: 1, name: 'cj', plays: 2 })
      expect(show.quality).toBe('4k')
      expect(show.key).toBe('show:better call saul')
    })

    it('folds tracks into their album with the artist as context', () => {
      const album = plays.topTitles({
        connection: seed(db),
        filters: plays.filters({ kind: 'track' }),
        metric: 'plays',
        limit: 5,
      })[0]

      expect([album.title, album.context, album.quality, album.plays]).toEqual([
        'Kid A',
        'Radiohead',
        null,
        1,
      ])
      // nobody played any one track twice, so there is no rewatcher to name
      expect(album.top_rewatcher).toBeNull()
      expect(album.key).toBe('album:kid a:radiohead')
    })

    it('keeps only groups with a rewatch under the rewatched metric', () => {
      const titles = plays.topTitles({
        connection: seed(db),
        filters: everything,
        metric: 'rewatches',
        limit: 10,
      })

      // equal on rewatches and plays, so the more recently played one leads
      expect(titles.map((row) => [row.title, row.rewatches])).toEqual([
        ['Heat', 1],
        ['Better Call Saul', 1],
      ])
    })

    it('honours the limit and the window', () => {
      seed(db)
      expect(
        plays.topTitles({ connection: db, filters: everything, metric: 'plays', limit: 2 }),
      ).toHaveLength(2)
      const recent = plays.topTitles({
        connection: db,
        filters: plays.filters({ since: at(2) }),
        metric: 'plays',
        limit: 10,
      })
      expect(recent.map((row) => [row.title, row.plays])).toEqual([['Heat', 2]])
    })

    it('keeps an episode without a known show as itself', () => {
      seed(db)
      // three episodes on syrax the library never described: two different
      // shows' "Episode 1", and one the ledger logged with no title at all.
      // Grouped by title they were one row called "Episode 1", which was the
      // top title on the fleet the first time real data was read.
      plays.insertPlays({
        connection: db,
        host: 'syrax',
        plays: [
          play({
            historyId: 701,
            ratingKey: '7001',
            kind: 'episode',
            accountId: 1,
            title: 'Episode 1',
            sectionId: '6',
          }),
          play({
            historyId: 702,
            ratingKey: '7001',
            kind: 'episode',
            accountId: 1,
            title: 'Episode 1',
            sectionId: '6',
          }),
          play({
            historyId: 703,
            ratingKey: '7002',
            kind: 'episode',
            accountId: 9,
            title: 'Episode 1',
            sectionId: '6',
          }),
          play({
            historyId: 704,
            ratingKey: '7003',
            kind: 'episode',
            accountId: 9,
            title: '',
            sectionId: '6',
          }),
        ],
      })

      const titles = plays.topTitles({
        connection: db,
        filters: plays.filters({ kind: 'episode', host: 'syrax' }),
        metric: 'plays',
        limit: 10,
      })

      expect(titles.map((row) => [row.title, row.context, row.plays, row.key])).toEqual([
        ['Episode 1', 'show not known', 2, 'item:syrax:7001'],
        ['Episode 1', 'show not known', 1, 'item:syrax:7002'],
        ['Untitled', 'show not known', 1, 'item:syrax:7003'],
      ])
      // the rewatch is real: the same viewer finished the same item twice
      expect(titles[0].rewatches).toBe(1)
      const history = plays.userHistory({
        connection: db,
        filters: plays.filters({ host: 'syrax', kind: 'episode' }),
        accountId: 9,
        page: 1,
        pageSize: 5,
      })
      expect(history.rows.map((row) => row.title)).toEqual(['Untitled', 'Episode 1'])
    })
  })

  describe('never played', () => {
    it('lists movies, shows and albums newest added first', () => {
      const page = never({ connection: seed(db) })

      expect(page.total).toBe(4)
      // newest addition first, an unknown date last, title breaks a tie
      expect(page.rows.map((row) => [row.kind, row.title, row.host])).toEqual([
        ['movie', 'Never Watched', 'syrax'],
        ['show', 'Untouched Show', 'syrax'],
        ['album', 'Silent Album', 'syrax'],
        ['movie', 'Also Never', 'syrax'],
      ])
      const [movie, show, album, undated] = page.rows
      expect([movie.year, movie.quality, movie.library, movie.items]).toEqual([
        2020,
        '4k',
        'Films',
        1,
      ])
      expect(movie.added_at).toEqual(utc(at(1)))
      expect(movie.key).toBe('syrax:movie:901')
      expect(movie.context).toBeNull()
      // a show is as good as its best episode, dated by its newest one
      expect([show.items, show.quality, show.library, show.key]).toEqual([
        2,
        '1080p',
        'Shows',
        'syrax:show:910',
      ])
      expect(show.added_at).toEqual(utc(at(4)))
      expect([album.context, album.items, album.quality, album.key]).toEqual([
        'Nobody',
        1,
        null,
        'syrax:album:920',
      ])
      expect(undated.added_at).toBeNull()
      // the retired film is gone from the library and must not be offered to watch
      expect(page.rows.filter((row) => row.title === 'Retired Film')).toEqual([])
    })

    it('means no plays in that window when a window is set', () => {
      seed(db)
      // Old Film was played 9 days ago, the Kid A track 8 days ago, syrax's Heat
      // 100 days ago; Better Call Saul had a play 4 days ago
      const week = never({ connection: db, filters: plays.filters({ since: at(7) }) })
      const year = never({ connection: db, filters: plays.filters({ since: at(365) }) })

      const weekTitles = new Set(week.rows.map((row) => row.title))
      expect(['Old Film', 'Kid A', 'Heat'].filter((title) => !weekTitles.has(title))).toEqual([])
      expect(weekTitles.has('Better Call Saul')).toBe(false)
      expect(weekTitles.has('Paddington 2')).toBe(false)
      const heat = must(week.rows.find((row) => row.title === 'Heat'))
      expect(heat.host).toBe('syrax')
      expect(year.rows.map((row) => row.title)).not.toContain('Old Film')
    })

    it('counts each kind and the movie qualities in its summary', () => {
      const page = never({ connection: seed(db) })

      expect(page.summary.movies).toBe(2)
      expect(page.summary.shows).toBe(1)
      expect(page.summary.albums).toBe(1)
      expect(page.summary.by_quality.map((row) => [row.quality, row.count])).toEqual([
        ['4k', 1],
        ['1080p', 1],
        ['720p', 0],
        ['other', 0],
      ])
      expect(page.summary.by_host.map((row) => [row.host, row.count])).toEqual([
        ['meleys', 0],
        ['vermithor', 0],
        ['caraxes', 0],
        ['syrax', 4],
        ['vhagar', 0],
      ])
    })

    it('filters by kind, quality, host and search', () => {
      seed(db)
      const movies = never({ connection: db, filters: plays.filters({ kind: 'movie' }) })
      const shows = never({ connection: db, filters: plays.filters({ kind: 'episode' }) })
      const albums = never({ connection: db, filters: plays.filters({ kind: 'track' }) })
      const hd = never({ connection: db, filters: plays.filters({ quality: '1080p' }) })
      const meleys = never({ connection: db, filters: plays.filters({ host: 'meleys' }) })
      const search = never({ connection: db, q: 'NEVER' })

      expect(new Set(movies.rows.map((row) => row.kind))).toEqual(new Set(['movie']))
      expect(movies.total).toBe(2)
      expect(shows.rows.map((row) => row.title)).toEqual(['Untouched Show'])
      expect(albums.rows.map((row) => row.title)).toEqual(['Silent Album'])
      // a show is as good as its best episode; an album has no quality and is out
      expect(new Set(hd.rows.map((row) => row.title))).toEqual(
        new Set(['Also Never', 'Untouched Show']),
      )
      expect(meleys.rows).toEqual([])
      expect(meleys.total).toBe(0)
      expect(meleys.summary.movies).toBe(0)
      expect(new Set(search.rows.map((row) => row.title))).toEqual(
        new Set(['Never Watched', 'Also Never']),
      )
      // the summary keeps the whole picture while the rows narrow
      expect(movies.summary.shows).toBe(1)
    })

    it('pages', () => {
      seed(db)
      const first = never({ connection: db, page: 1, pageSize: 3 })
      const second = never({ connection: db, page: 2, pageSize: 3 })
      const beyond = never({ connection: db, page: 9, pageSize: 3 })

      expect([first.total, first.rows.length, first.page, first.page_size]).toEqual([4, 3, 1, 3])
      expect(second.rows.map((row) => row.title)).toEqual(['Also Never'])
      expect(beyond.rows).toEqual([])
      expect(beyond.total).toBe(4)
    })

    it('sorts an impossible addition date with the undated', () => {
      seed(db)
      // Plex carries a few items stamped decades ahead: QI on meleys says it was
      // added in 2098. Sorted newest first they sat at the top of the list
      // forever, over every title actually added this week.
      plays.upsertItems({
        connection: db,
        host: 'syrax',
        items: [
          item({ ratingKey: '930', title: 'Stamped Ahead', sectionId: '3', addedAt: at(-26_000) }),
          item({ ratingKey: '931', title: 'No Date', sectionId: '3', addedAt: null }),
        ],
        seenAt: T0,
      })

      const page = never({ connection: db })

      expect(page.rows.map((row) => row.title)).toEqual([
        'Never Watched',
        'Untouched Show',
        'Silent Album',
        'Stamped Ahead',
        'Also Never',
        'No Date',
      ])
      // the date itself is still reported: it is what the server says, and a row
      // printing a nonsense date at the bottom is more honest than one hiding it
      const ahead = must(page.rows.find((row) => row.title === 'Stamped Ahead'))
      expect(ahead.added_at).toEqual(utc(at(-26_000)))
    })
  })

  describe('sync status', () => {
    it('reports every host handed in with counts and outcomes', () => {
      seed(db)
      plays.markHistory({ connection: db, host: 'meleys', at: T0, ok: true, error: null })
      plays.markLibrary({
        connection: db,
        host: 'meleys',
        at: addSeconds({ at: T0, seconds: -3600 }),
        ok: true,
        error: null,
      })
      plays.markHistory({ connection: db, host: 'syrax', at: T0, ok: false, error: 'timeout' })

      const [meleys, syrax, vhagar] = plays.syncStatus({
        connection: db,
        hosts: [
          plexHost({ name: 'meleys', plexUrl: 'http://192.168.50.2:32400' }),
          plexHost({ name: 'syrax', plexUrl: 'http://192.168.50.5:32400' }),
          plexHost({ name: 'vhagar', plexUrl: 'https://192.168.50.6:32400' }),
        ],
      })

      expect(meleys).toEqual({
        host: 'meleys',
        friendly_name: 'Meleys',
        plex_url: 'http://192.168.50.2:32400',
        reachable: true,
        history_synced_at: T0,
        library_synced_at: addSeconds({ at: T0, seconds: -3600 }),
        history_since: utc(at(40)),
        plays: 10,
        items: 6,
        last_error: null,
      })
      // the retired film is not in the library any more, so it is not an item
      expect([syrax.reachable, syrax.last_error, syrax.plays, syrax.items]).toEqual([
        false,
        'timeout',
        1,
        6,
      ])
      expect(syrax.history_since).toEqual(utc(at(100)))
      // never synced, never identified: listed, unreachable, empty
      expect(vhagar).toEqual({
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

    it('keeps the previous error out of a later success', () => {
      plays.markHistory({
        connection: db,
        host: 'meleys',
        at: addSeconds({ at: T0, seconds: -300 }),
        ok: false,
        error: 'refused',
      })
      plays.markHistory({ connection: db, host: 'meleys', at: T0, ok: true, error: null })

      const status = plays.syncStatus({
        connection: db,
        hosts: [plexHost({ name: 'meleys', plexUrl: 'http://x' })],
      })[0]

      expect(status.reachable).toBe(true)
      expect(status.last_error).toBeNull()
    })

    it('answers the earliest play as null on an empty ledger and per host otherwise', () => {
      seed(db)
      expect(plays.earliestPlay({ connection: db, host: null })).toBe(at(100))
      expect(plays.earliestPlay({ connection: db, host: 'meleys' })).toBe(at(40))
      expect(plays.earliestPlay({ connection: db, host: 'vhagar' })).toBeNull()
    })

    it('opens the store through the shared session', () => {
      // the API and the sync loop each open their own session; whatever one
      // commits the other reads, which is the whole point of one file
      const path = tempDbPath()
      session({
        path,
        work: (connection) => {
          plays.initDb(connection)
          plays.insertPlays({
            connection,
            host: 'meleys',
            plays: [play({ historyId: 1, ratingKey: '100' })],
          })
        },
      })
      // a read session, as the API opens one: the base table is a temp table,
      // which a deferred transaction can create without the write lock
      const users = session({
        path,
        mode: 'read',
        work: (connection) => plays.users({ connection, filters: everything }),
      })
      expect(users[0].plays).toBe(1)
    })
  })

  describe('excluded libraries', () => {
    it('stores on each section whether the page counts it', () => {
      plays.upsertSections({
        connection: db,
        host: 'caraxes',
        sections: [
          section({ section_id: '2', title: '02. Stand Up Comedy', kind: 'movie' }),
          section({ section_id: '16', title: '99. Tutorials', kind: 'movie' }),
          section({ section_id: '20', title: '97. Home Videos', kind: 'movie' }),
        ],
        excludedIds: new Set(['16', '20']),
      })

      expect(plays.excludedSectionIds({ connection: db, host: 'caraxes' })).toEqual(
        new Set(['16', '20']),
      )
      // the flag is per host: another server's section 16 is its own question
      expect(plays.excludedSectionIds({ connection: db, host: 'meleys' })).toEqual(new Set())
    })

    it('counts a section again once it stops being excluded', () => {
      const sections = [section({ section_id: '16', title: '99. Tutorials', kind: 'movie' })]
      plays.upsertSections({
        connection: db,
        host: 'caraxes',
        sections,
        excludedIds: new Set(['16']),
      })

      plays.upsertSections({ connection: db, host: 'caraxes', sections })

      expect(plays.excludedSectionIds({ connection: db, host: 'caraxes' })).toEqual(new Set())
    })

    it('takes the plays and the items of a purged section', () => {
      plays.upsertItems({
        connection: db,
        host: 'caraxes',
        items: [
          item({ ratingKey: '900', title: 'How to grep', sectionId: '16' }),
          item({ ratingKey: '901', title: 'Birthday', sectionId: '20' }),
          item({ ratingKey: '100', title: 'Heat', sectionId: '2' }),
        ],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'caraxes',
        plays: [
          play({ historyId: 1, ratingKey: '900', sectionId: '16' }),
          play({ historyId: 2, ratingKey: '901', sectionId: '20' }),
          play({ historyId: 3, ratingKey: '100', sectionId: '2' }),
        ],
      })

      const purged = plays.purgeSections({
        connection: db,
        host: 'caraxes',
        sectionIds: new Set(['16', '20']),
      })

      expect([purged.plays, purged.items]).toEqual([2, 2])
      expect(
        column({ connection: db, sql: 'SELECT rating_key FROM plex_plays ORDER BY 1' }),
      ).toEqual(['100'])
      expect(
        column({ connection: db, sql: 'SELECT rating_key FROM plex_items ORDER BY 1' }),
      ).toEqual(['100'])
    })

    it('purges a play whose section only its item knows', () => {
      // the ledger does record rows without a librarySectionID; the item behind
      // one still says which library it came from
      plays.upsertItems({
        connection: db,
        host: 'caraxes',
        items: [item({ ratingKey: '900', sectionId: '16' })],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'caraxes',
        plays: [play({ historyId: 1, ratingKey: '900', sectionId: null })],
      })

      expect(
        plays.purgeSections({ connection: db, host: 'caraxes', sectionIds: new Set(['16']) }).plays,
      ).toBe(1)
      expect(column({ connection: db, sql: 'SELECT rating_key FROM plex_plays' })).toEqual([])
    })

    it('touches nothing when purging nothing', () => {
      plays.upsertItems({
        connection: db,
        host: 'caraxes',
        items: [item({ ratingKey: '100' })],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'caraxes',
        plays: [play({ historyId: 1, ratingKey: '100' })],
      })

      const purged = plays.purgeSections({ connection: db, host: 'caraxes', sectionIds: new Set() })

      expect([purged.plays, purged.items]).toEqual([0, 0])
      expect(column({ connection: db, sql: 'SELECT rating_key FROM plex_plays' })).toEqual(['100'])
    })

    it('leaves the rows of another host alone when purging', () => {
      plays.upsertItems({
        connection: db,
        host: 'meleys',
        items: [item({ ratingKey: '900', sectionId: '16' })],
        seenAt: T0,
      })
      plays.insertPlays({
        connection: db,
        host: 'meleys',
        plays: [play({ historyId: 1, ratingKey: '900', sectionId: '16' })],
      })

      plays.purgeSections({ connection: db, host: 'caraxes', sectionIds: new Set(['16']) })

      expect(column({ connection: db, sql: 'SELECT rating_key FROM plex_plays' })).toEqual(['900'])
    })

    it('adds the column to a database written before the rule', () => {
      // CREATE TABLE IF NOT EXISTS never widens a table, so an existing file
      // would answer every section read with "no such column"
      const path = tempDbPath()
      session({
        path,
        work: (connection) => {
          connection
            .prepare(
              `
            CREATE TABLE plex_sections (
                host TEXT NOT NULL, section_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
                PRIMARY KEY (host, section_id)
            )
            `,
            )
            .run()
          connection
            .prepare(
              'INSERT INTO plex_sections (host, section_id, title, kind) VALUES (?, ?, ?, ?)',
            )
            .run('caraxes', '16', '99. Tutorials', 'movie')
        },
      })

      session({
        path,
        work: (connection) => {
          plays.initDb(connection)

          // nothing is excluded by the backfill; the next inventory says so
          expect(plays.excludedSectionIds({ connection, host: 'caraxes' })).toEqual(new Set())
        },
      })
    })
  })
})
