import { describe, expect, it } from 'vitest'
import {
  type Account,
  type Device,
  LEAF_TYPE,
  type PageInfo,
  type PlayEntry,
  QUALITY_RANK,
  type Quality,
  type ServerInfo,
  historyId,
  pageInfo,
  parseAccounts,
  parseDevices,
  parseHistory,
  parseItems,
  parseSections,
  parseServer,
  qualityBucket,
  section,
} from '@/probes/plex.js'
import { fixtureJson } from '@/test/support.js'

// --- history --------------------------------------------------------------

describe('parseHistory', () => {
  it('keeps only the three playable kinds with a history id', () => {
    const entries = parseHistory(fixtureJson('plex_history_page.json'))

    // the clip, the row with no historyKey, the non-digit ratingKey and the
    // bare string are all skipped, and none of them raises
    expect(entries.map((entry) => entry.history_id)).toEqual([3132, 3131, 3130])
    expect(entries.map((entry) => entry.kind)).toEqual(['movie', 'episode', 'track'])
  })

  it('reads every field the ledger carries', () => {
    const [first] = parseHistory(fixtureJson('plex_history_page.json'))

    expect(first).toEqual({
      history_id: 3132,
      rating_key: '57240',
      kind: 'movie',
      title: 'Paddington 2',
      section_id: '11',
      account_id: 830901987,
      device_id: 460,
      viewed_at: 1789703560,
    } satisfies PlayEntry)
  })

  it('tolerates a missing device', () => {
    // tracks played through some clients carry no deviceID at all
    const track = parseHistory(fixtureJson('plex_history_page.json'))[2]

    expect(track.device_id).toBeNull()
    expect(track.account_id).toBe(13536868)
  })

  it('is empty on an empty or malformed container', () => {
    expect(parseHistory({ MediaContainer: { size: 0 } })).toEqual([])
    expect(parseHistory({})).toEqual([])
    expect(parseHistory({ MediaContainer: 'nope' })).toEqual([])
    expect(parseHistory({ MediaContainer: { Metadata: 'nope' } })).toEqual([])
  })
})

describe('pageInfo', () => {
  it('reads size, total and offset', () => {
    expect(pageInfo(fixtureJson('plex_history_page.json'))).toEqual({
      size: 4,
      total_size: 1599,
      offset: 0,
    } satisfies PageInfo)
  })

  it('falls back to the size when there is no total', () => {
    // a container answered with size only (the metadata batch does this) is a
    // complete answer, so the total is the size
    expect(pageInfo({ MediaContainer: { size: 3 } })).toEqual({
      size: 3,
      total_size: 3,
      offset: 0,
    } satisfies PageInfo)
  })

  it('is null on a malformed container', () => {
    expect(pageInfo({})).toBeNull()
    expect(pageInfo({ MediaContainer: { size: 'many' } })).toBeNull()
  })
})

describe('historyId', () => {
  it.each([
    ['/status/sessions/history/3132', 3132],
    ['/status/sessions/history/0', 0],
    ['/status/sessions/history/', null],
    ['/status/sessions/history/abc', null],
    ['', null],
    [null, null],
  ])('is the trailing integer of %j', (key, expected) => {
    expect(historyId(key)).toBe(expected)
  })
})

// --- items ----------------------------------------------------------------

describe('parseItems', () => {
  it('reads a movie with its media', () => {
    const [movie] = parseItems({ payload: fixtureJson('plex_metadata_batch.json') })

    expect(movie.rating_key).toBe('57240')
    expect(movie.kind).toBe('movie')
    expect(movie.title).toBe('Paddington 2')
    expect(movie.year).toBe(2017)
    expect(movie.section_id).toBe('11')
    expect(movie.duration_ms).toBe(9141664)
    expect(movie.video_resolution).toBe('1080')
    expect(movie.width).toBe(1920)
    // letterboxed: the file is 1080p by Plex's own label though only 796 rows tall
    expect(movie.height).toBe(796)
    expect(movie.quality).toBe('1080p')
    expect(movie.added_at).toBe(1700000000)
    expect(movie.thumb).toBe('/library/metadata/57240/thumb/1700000000')
    expect(movie.parent_rating_key).toBeNull()
    expect(movie.grandparent_title).toBeNull()
  })

  it('reads an episode with its show and picks the best version', () => {
    const episode = parseItems({ payload: fixtureJson('plex_metadata_batch.json') })[1]

    expect(episode.kind).toBe('episode')
    expect(episode.title).toBe('Smoke')
    expect(episode.index).toBe(1)
    expect(episode.parent_index).toBe(4)
    expect(episode.parent_rating_key).toBe('41200')
    expect(episode.parent_title).toBe('Season 4')
    expect(episode.grandparent_rating_key).toBe('41000')
    expect(episode.grandparent_title).toBe('Better Call Saul')
    // two versions on disk: the item is as good as its best one
    expect(episode.quality).toBe('4k')
    expect(episode.width).toBe(3840)
  })

  it('reads a track with no video and no quality', () => {
    const track = parseItems({ payload: fixtureJson('plex_metadata_batch.json') })[2]

    expect(track.kind).toBe('track')
    expect(track.title).toBe('Everything In Its Right Place')
    expect(track.parent_title).toBe('Kid A')
    expect(track.grandparent_title).toBe('Radiohead')
    expect(track.duration_ms).toBe(251000)
    expect(track.video_resolution).toBeNull()
    expect(track.width).toBeNull()
    expect(track.quality).toBeNull()
  })

  it('reads a section page and survives an item with no media', () => {
    const items = parseItems({ payload: fixtureJson('plex_section_page.json') })

    expect(items.map((item) => item.rating_key)).toEqual(['100', '101'])
    expect(items[0].quality).toBe('720p')
    expect(items[1].quality).toBeNull()
    expect(items[1].section_id).toBeNull()
    expect(items[1].duration_ms).toBeNull()
  })

  it('skips kinds the ledger never logs', () => {
    const payload = {
      MediaContainer: {
        Metadata: [
          { ratingKey: '1', type: 'show', title: 'A show' },
          { ratingKey: '2', type: 'movie', title: 'Kept' },
          { ratingKey: 'x', type: 'movie', title: 'Bad key' },
          { type: 'movie', title: 'No key' },
          'junk',
        ],
      },
    }

    expect(parseItems({ payload }).map((item) => item.title)).toEqual(['Kept'])
  })

  it('takes the section from the caller when the row lacks one', () => {
    // a section listing omits librarySectionID on its rows; a metadata answer
    // carries it, and a row's own value still wins
    const listed = { MediaContainer: { Metadata: [{ ratingKey: '1', type: 'movie', title: 'A' }] } }
    const described = {
      MediaContainer: {
        Metadata: [{ ratingKey: '2', type: 'movie', title: 'B', librarySectionID: 9 }],
      },
    }

    expect(parseItems({ payload: listed, sectionId: '8' })[0].section_id).toBe('8')
    expect(parseItems({ payload: described, sectionId: '8' })[0].section_id).toBe('9')
    expect(parseItems({ payload: listed })[0].section_id).toBeNull()
  })
})

// --- quality --------------------------------------------------------------

describe('qualityBucket', () => {
  it.each<[string | null, number | null, Quality | null]>([
    ['4k', 3840, '4k'],
    ['4K', null, '4k'],
    ['1080', 1920, '1080p'],
    ['1080p', null, '1080p'],
    ['1080i', null, '1080p'],
    ['720', 1280, '720p'],
    ['720p', null, '720p'],
    ['sd', 720, 'sd'],
    ['480', null, 'sd'],
    ['576', null, 'sd'],
    // unlabelled files fall back to width, never to height: a letterboxed
    // 1080p file is 796 rows tall and would otherwise read as sd
    [null, 3840, '4k'],
    ['', 3000, '4k'],
    [null, 1920, '1080p'],
    [null, 1700, '1080p'],
    [null, 1280, '720p'],
    [null, 1200, '720p'],
    [null, 720, 'sd'],
    [null, 1, 'sd'],
    [null, 0, null],
    [null, null, null],
    ['weird', null, null],
    ['weird', 1920, '1080p'],
  ])('buckets resolution %j at width %j as %j', (videoResolution, width, expected) => {
    expect(qualityBucket({ videoResolution, width })).toBe(expected)
  })

  it('ranks the buckets best first', () => {
    expect(QUALITY_RANK).toEqual({ '4k': 4, '1080p': 3, '720p': 2, sd: 1 })
  })
})

// --- accounts, devices, sections, server ----------------------------------

describe('parseAccounts', () => {
  it('keeps every row with an id, even the nameless one', () => {
    expect(parseAccounts(fixtureJson('plex_accounts.json'))).toEqual([
      { account_id: 0, name: '', thumb: null },
      { account_id: 1, name: 'cj', thumb: 'https://plex.tv/users/1/avatar' },
      {
        account_id: 830901987,
        name: 'danny',
        thumb: 'https://plex.tv/users/830901987/avatar',
      },
    ] satisfies readonly Account[])
  })
})

describe('parseDevices', () => {
  it('keeps every row with an id', () => {
    expect(parseDevices(fixtureJson('plex_devices.json'))).toEqual([
      { device_id: 460, name: 'Chrome', platform: 'Chrome', client_identifier: 'abc-460' },
      { device_id: 12, name: 'Apple TV', platform: 'tvOS', client_identifier: 'abc-12' },
    ] satisfies readonly Device[])
  })
})

describe('parseSections', () => {
  it('keeps the three playable library types', () => {
    // the photo library is skipped, so is a directory with no key; a library
    // pointed at two folders carries both, and one pointed at none carries no
    // location rather than a guessed one
    expect(parseSections(fixtureJson('plex_sections.json'))).toEqual([
      section({
        section_id: '13',
        title: '01. 4K Movies',
        kind: 'movie',
        locations: ['/volume1/Meleys/Media/4K Movies', '/volume1/Meleys/Vhagar/Media/4K Movies'],
      }),
      section({
        section_id: '6',
        title: '03. 4K TV Shows',
        kind: 'episode',
        locations: ['/volume1/Meleys/Media/4K TV'],
      }),
      section({ section_id: '21', title: '20. Music Lossless', kind: 'track', locations: [] }),
    ])
  })
})

describe('LEAF_TYPE', () => {
  it('is the Plex type number the inventory pages by', () => {
    expect(LEAF_TYPE).toEqual({ movie: 1, episode: 4, track: 10 })
  })
})

describe('parseServer', () => {
  it('reads the root container', () => {
    expect(parseServer(fixtureJson('plex_root.json'))).toEqual({
      friendly_name: 'Meleys',
      machine_id: 'df9720c0b441af2031064b1a530febd082503325',
      version: '1.43.4.10903-e5521bd8c',
    } satisfies ServerInfo)
  })

  it('is null without an identity', () => {
    expect(parseServer({ MediaContainer: { friendlyName: 'x' } })).toBeNull()
    expect(parseServer({})).toBeNull()
  })
})
