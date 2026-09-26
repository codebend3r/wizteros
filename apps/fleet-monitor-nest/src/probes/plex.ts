// Pure parsers for what a Plex Media Server answers over its own API.
//
// Every function here takes JSON already decoded from one Plex response and
// returns frozen data. No clock, no network, no sqlite: the sync loop stamps
// and stores, these only read. That is what lets the whole parsing surface be
// tested against payloads captured from the real servers without a server in
// the loop, the same contract probes/docker follows.
//
// Shapes were measured on 2026-09-18 against PMS 1.43.4 with the owner token,
// with `Accept: application/json`:
//
// - `/status/sessions/history/all` rows carry historyKey, key, ratingKey,
//   librarySectionID, title, type, thumb, viewedAt, accountID, deviceID. They
//   carry no parent or grandparent titles, so an episode row says "Smoke" and
//   nothing about Better Call Saul; that comes from metadata.
// - `/library/metadata/{k1,k2,...}` and `/library/sections/{id}/all` answer the
//   same item shape, with a `Media` list per item holding videoResolution,
//   width, height, bitrate and duration.
// - `/accounts` lists id, name, thumb; `/devices` lists id, name, platform,
//   clientIdentifier; `/library/sections` lists key, type, title; `/` carries
//   friendlyName, machineIdentifier and version.

export type Kind = 'movie' | 'episode' | 'track'
export type Quality = '4k' | '1080p' | '720p' | 'sd'

// The three things the ledger logs, and the only three the page is about. A
// clip, a photo or a trailer in the history is skipped, the way Tautulli's own
// `write_session_history` skips them.
export const KINDS: ReadonlySet<string> = new Set<Kind>(['movie', 'episode', 'track'])

// Plex's `type` number for the leaf item of each library type: what
// `/library/sections/{id}/all?type=N` pages by. Keyed by the leaf kind rather
// than the section type, because the section itself says "show" and "artist"
// and the inventory wants episodes and tracks.
export const LEAF_TYPE: Readonly<Record<Kind, number>> = { movie: 1, episode: 4, track: 10 }

// Best first. A group's quality is its best played version, and the number is
// what SQL orders by.
export const QUALITY_RANK: Readonly<Record<Quality, number>> = {
  '4k': 4,
  '1080p': 3,
  '720p': 2,
  sd: 1,
}

/** One completed view, as the server's own ledger records it. */
export type PlayEntry = Readonly<{
  history_id: number
  rating_key: string
  kind: Kind
  title: string
  section_id: string | null
  account_id: number
  device_id: number | null
  viewed_at: number
}>

/**
 * One library item, movie, episode or track, with its best version's video
 * facts. `quality` is null for a track (no video) and for an item that
 * arrived with no Media block at all; the page never invents a resolution.
 */
export type MediaItem = Readonly<{
  rating_key: string
  kind: Kind
  title: string
  parent_rating_key: string | null
  parent_title: string | null
  parent_index: number | null
  grandparent_rating_key: string | null
  grandparent_title: string | null
  index: number | null
  year: number | null
  section_id: string | null
  duration_ms: number | null
  video_resolution: string | null
  width: number | null
  height: number | null
  quality: Quality | null
  thumb: string | null
  added_at: number | null
}>

export type Account = Readonly<{
  account_id: number
  name: string
  thumb: string | null
}>

export type Device = Readonly<{
  device_id: number
  name: string
  platform: string | null
  client_identifier: string | null
}>

/**
 * One library, named by the leaf kind it holds, with the folders it is
 * pointed at. `locations` is what the exclusion rule reads: a library is known
 * by its title on the page but by its path in the rule, and a title can be
 * renamed underneath either one. Python defaulted it to an empty tuple, so
 * construct sections through `section` to keep that default.
 */
export type Section = Readonly<{
  section_id: string
  title: string
  kind: Kind
  locations: readonly string[]
}>

export const section = ({
  section_id,
  title,
  kind,
  locations = [],
}: {
  section_id: string
  title: string
  kind: Kind
  locations?: readonly string[]
}): Section => ({ section_id, title, kind, locations })

export type ServerInfo = Readonly<{
  friendly_name: string
  machine_id: string
  version: string
}>

/**
 * What a container says about the page it is: how many rows it holds, how
 * many exist, and where it starts. The sync loop stops paging on these rather
 * than on an empty page, so a server that answers one row short does not cost
 * an extra round trip per section.
 */
export type PageInfo = Readonly<{
  size: number
  total_size: number
  offset: number
}>

// PARSERS: the probes port adds the rest of fleet_monitor/probes/plex.py below
// this line (_SECTION_KIND, _RESOLUTION_LABELS, history_id, page_info,
// parse_history, quality_bucket, parse_items, parse_accounts, parse_devices,
// parse_sections, parse_server), keeping every type and constant above as is.

// What a section's own `type` means in leaf terms.
const SECTION_KIND: ReadonlyMap<string, Kind> = new Map([
  ['movie', 'movie'],
  ['show', 'episode'],
  ['artist', 'track'],
])

// Plex's own labels, as the servers actually spell them. Lower-cased before
// lookup because "4K" and "4k" both occur in the wild.
const RESOLUTION_LABELS: ReadonlyMap<string, Quality> = new Map([
  ['4k', '4k'],
  ['1080', '1080p'],
  ['1080p', '1080p'],
  ['1080i', '1080p'],
  ['720', '720p'],
  ['720p', '720p'],
  ['sd', 'sd'],
  ['480', 'sd'],
  ['576', 'sd'],
])

type JsonObject = Readonly<Record<string, unknown>>

// A decoded JSON object (Python's Mapping), as opposed to an array or a
// scalar: the one shape whose fields can be read.
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isKind = (value: unknown): value is Kind => typeof value === 'string' && KINDS.has(value)

const container = (payload: unknown): JsonObject => {
  if (!isObject(payload)) {
    return {}
  }
  const found = payload.MediaContainer
  return isObject(found) ? found : {}
}

const rows = ({ payload, key }: { payload: unknown; key: string }): readonly JsonObject[] => {
  const found = container(payload)[key]
  return Array.isArray(found) ? found.filter(isObject) : []
}

/**
 * An integer from what Plex sends, which is sometimes a number and sometimes
 * the digits as a string. Booleans are not integers here.
 */
const integer = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }
  return null
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * A ratingKey as the string of digits every other endpoint expects. Anything
 * that is not digits is not a key the metadata endpoint can answer for, so it
 * is dropped rather than carried into a failing url.
 */
const key = (value: unknown): string | null => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : null
  }
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? value : null
}

/** The integer at the end of `/status/sessions/history/<id>`, or null. */
export const historyId = (historyKey: unknown): number | null => {
  if (typeof historyKey !== 'string') {
    return null
  }
  const tail = historyKey.slice(historyKey.lastIndexOf('/') + 1)
  return /^[0-9]+$/.test(tail) ? Number.parseInt(tail, 10) : null
}

/**
 * The container's own paging facts. A container with a size but no totalSize
 * is a whole answer, so its total is its size.
 */
export const pageInfo = (payload: unknown): PageInfo | null => {
  const found = container(payload)
  const size = integer(found.size)
  if (size === null) {
    return null
  }
  return {
    size,
    total_size: integer(found.totalSize) ?? size,
    offset: integer(found.offset) ?? 0,
  }
}

/**
 * Completed views from one page of `/status/sessions/history/all`.
 *
 * A malformed row is skipped rather than raised on: one bad row must not cost
 * the whole page, and a page that fails costs the whole pass for that host.
 * Rows without a history id cannot be stored idempotently, rows without a
 * digit ratingKey cannot be enriched, and rows of any other kind are not plays
 * the page counts; all three are dropped.
 */
export const parseHistory = (payload: unknown): readonly PlayEntry[] =>
  rows({ payload, key: 'Metadata' }).flatMap((row): readonly PlayEntry[] => {
    const kind = row.type
    const entryId = historyId(row.historyKey)
    const ratingKey = key(row.ratingKey)
    const account = integer(row.accountID)
    const viewedAt = integer(row.viewedAt)
    if (
      !isKind(kind) ||
      entryId === null ||
      ratingKey === null ||
      account === null ||
      viewedAt === null
    ) {
      return []
    }
    return [
      {
        history_id: entryId,
        rating_key: ratingKey,
        kind,
        title: text(row.title) ?? '',
        section_id: key(row.librarySectionID),
        account_id: account,
        device_id: integer(row.deviceID),
        viewed_at: viewedAt,
      },
    ]
  })

/**
 * The coarse bucket the page groups by.
 *
 * Plex's own label wins when it is one it uses; an unlabelled or oddly
 * labelled file falls back to its width. Width rather than height on purpose:
 * a letterboxed 1080p file is 1920 wide and 796 tall, and judging by height
 * would file it under sd. No width and no label is no video, or no media
 * block, and stays null rather than becoming sd.
 */
export const qualityBucket = ({
  videoResolution,
  width,
}: {
  videoResolution: string | null
  width: number | null
}): Quality | null => {
  const labelled = RESOLUTION_LABELS.get(videoResolution?.trim().toLowerCase() ?? '')
  if (labelled !== undefined) {
    return labelled
  }
  if (width === null || width <= 0) {
    return null
  }
  if (width >= 3000) {
    return '4k'
  }
  if (width >= 1700) {
    return '1080p'
  }
  if (width >= 1200) {
    return '720p'
  }
  return 'sd'
}

const rank = (version: JsonObject): number => {
  const quality = qualityBucket({
    videoResolution: text(version.videoResolution),
    width: integer(version.width),
  })
  return quality === null ? 0 : QUALITY_RANK[quality]
}

/**
 * The version of an item worth describing it by: the best quality, or the
 * first when none has a video track. An item can hold several files (a 4K and
 * a 1080p cut of the same episode), and the page reports it as the best one,
 * which is also what a viewer picking it in Plex is offered first.
 */
const bestMedia = (row: JsonObject): JsonObject | null => {
  const media = row.Media
  if (!Array.isArray(media)) {
    return null
  }
  const versions = media.filter(isObject)
  if (versions.length === 0) {
    return null
  }
  // Python's max() keeps the first of equal ranks, so only a strictly better
  // version replaces the one held
  return versions.reduce((best, version) => (rank(version) > rank(best) ? version : best))
}

/**
 * Items from `/library/metadata/{keys}` or `/library/sections/{id}/all`.
 *
 * Both answer the same shape, with one gap: a section listing omits
 * `librarySectionID` on each row, since the section is the one being listed
 * (measured 2026-09-18). The caller that paged a section hands its id in as
 * `sectionId`, and a row's own value still wins where it is present.
 *
 * Only the three playable kinds are kept: a section listing paged by leaf type
 * never sends anything else, and a metadata batch answered for a show or a
 * season is not an item the ledger can hold a play against.
 */
export const parseItems = ({
  payload,
  sectionId = null,
}: {
  payload: unknown
  sectionId?: string | null
}): readonly MediaItem[] =>
  rows({ payload, key: 'Metadata' }).flatMap((row): readonly MediaItem[] => {
    const kind = row.type
    const ratingKey = key(row.ratingKey)
    if (!isKind(kind) || ratingKey === null) {
      return []
    }
    const version = bestMedia(row)
    const resolution = version === null ? null : text(version.videoResolution)
    const width = version === null ? null : integer(version.width)
    const duration = integer(row.duration) ?? (version === null ? null : integer(version.duration))
    return [
      {
        rating_key: ratingKey,
        kind,
        title: text(row.title) ?? '',
        parent_rating_key: key(row.parentRatingKey),
        parent_title: text(row.parentTitle),
        parent_index: integer(row.parentIndex),
        grandparent_rating_key: key(row.grandparentRatingKey),
        grandparent_title: text(row.grandparentTitle),
        index: integer(row.index),
        year: integer(row.year),
        section_id: key(row.librarySectionID) ?? sectionId,
        duration_ms: duration,
        video_resolution: resolution,
        width,
        height: version === null ? null : integer(version.height),
        quality: qualityBucket({ videoResolution: resolution, width }),
        thumb: text(row.thumb),
        added_at: integer(row.addedAt),
      },
    ]
  })

/**
 * Every account the server knows, from `/accounts`.
 *
 * The nameless id 0 row is kept: plays are recorded against it on at least one
 * server, and a play must never be dropped for want of a name.
 */
export const parseAccounts = (payload: unknown): readonly Account[] =>
  rows({ payload, key: 'Account' }).flatMap((row): readonly Account[] => {
    const accountId = integer(row.id)
    return accountId === null
      ? []
      : [{ account_id: accountId, name: text(row.name) ?? '', thumb: text(row.thumb) }]
  })

export const parseDevices = (payload: unknown): readonly Device[] =>
  rows({ payload, key: 'Device' }).flatMap((row): readonly Device[] => {
    const deviceId = integer(row.id)
    return deviceId === null
      ? []
      : [
          {
            device_id: deviceId,
            name: text(row.name) ?? '',
            platform: text(row.platform),
            client_identifier: text(row.clientIdentifier),
          },
        ]
  })

/**
 * The folders one section row names. A library with several is listed several
 * times; one with none (a section the server answers for but no longer has a
 * folder behind) is an empty list, not a guess.
 */
const locations = (row: JsonObject): readonly string[] => {
  const found = row.Location
  if (!Array.isArray(found)) {
    return []
  }
  return found.filter(isObject).flatMap((location) => {
    const path = text(location.path)
    return path === null ? [] : [path]
  })
}

/**
 * The libraries the inventory pages: movie, show and artist sections, named by
 * the leaf kind they hold. Photo and other libraries hold nothing the ledger
 * logs and are skipped.
 */
export const parseSections = (payload: unknown): readonly Section[] =>
  rows({ payload, key: 'Directory' }).flatMap((row): readonly Section[] => {
    const sectionId = key(row.key)
    const type = row.type
    const kind = typeof type === 'string' ? SECTION_KIND.get(type) : undefined
    return sectionId === null || kind === undefined
      ? []
      : [
          section({
            section_id: sectionId,
            title: text(row.title) ?? '',
            kind,
            locations: locations(row),
          }),
        ]
  })

/**
 * Who the server says it is, from `GET /`. Null without a machine id: a root
 * that cannot identify itself is a proxy page, not a Plex server.
 */
export const parseServer = (payload: unknown): ServerInfo | null => {
  const found = container(payload)
  const machineId = text(found.machineIdentifier)
  if (machineId === null) {
    return null
  }
  return {
    friendly_name: text(found.friendlyName) ?? '',
    machine_id: machineId,
    version: text(found.version) ?? '',
  }
}
