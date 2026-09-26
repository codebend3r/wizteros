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
