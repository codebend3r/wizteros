// The play-history store: schema, writes, cursors, and every aggregate the
// API serves.
//
// One SQLite file holds the fleet. Every table is prefixed `plex_` and keyed
// by the config host name, so one query answers for five servers and a host
// filter is one predicate. Every function takes a connection: sessions come
// from `session` in db.ts, and a pass's page of plays commits with its cursor,
// or neither does.
//
// The package is four modules and this re-export, so every caller keeps
// importing from `@/plays/index.js` whichever one the name moved to: `base`
// holds the filters and the joined select, `ledger` the schema and the writes,
// `views` the aggregates, `neverPlayed` the unplayed engine.
//
// Two rules the aggregates share, stated once here because every view leans on
// them:
//
// - A play is grouped by what a viewer would name: a movie by (title, year),
//   an episode by its show, a track by its album. The same film on two servers
//   is one row listing both. A play whose item is gone from the library keeps
//   its own title and groups under it, since nothing better is known.
// - A rewatch is the same viewer finishing the same item again. It is counted
//   per (viewer, item) as plays minus one and summed over the group, so a
//   viewer working through ten episodes has rewatched nothing.
// - One viewing is one play, however many times Plex logged it. The server
//   writes a history row each time an item is marked watched, and some clients
//   mark a single viewing twice: once at the watched threshold, again at the
//   stop (measured 2026-09-19: 222 of 6,253 rows fleet-wide, mostly iOS and
//   tvOS, a minute or less apart in half of them). A completion that lands
//   before the same viewer could even have replayed the item in full is the
//   same viewing, and every read here drops it. The ledger keeps the row, so
//   the rule can change without a resync.

export { filters, KIND_ORDER, QUALITY_FILTERS } from '@/plays/base.js'
export type { Filters, QualityFilter } from '@/plays/base.js'
export {
  earliestPlay,
  excludedSectionIds,
  historyCursor,
  initDb,
  insertPlays,
  markHistory,
  markLibrary,
  missingItemKeys,
  purgeSections,
  retireUnseenItems,
  setHistoryCursor,
  stubMissingItems,
  syncStatus,
  upsertAccounts,
  upsertDevices,
  upsertItems,
  upsertSections,
  upsertServer,
} from '@/plays/ledger.js'
export type { Purged, ServerStatus } from '@/plays/ledger.js'
export { neverPlayed } from '@/plays/neverPlayed.js'
export type {
  NeverHostCount,
  NeverKind,
  NeverPlayedPage,
  NeverPlayedRow,
  NeverPlayedSummary,
  NeverQualityCount,
} from '@/plays/neverPlayed.js'
export { overview, titleHistory, topTitles, userHistory, users } from '@/plays/views.js'
export type {
  Bucket,
  HistoryPage,
  HistoryRow,
  HostCount,
  KindCount,
  Metric,
  Overview,
  QualityCount,
  Rewatcher,
  Timeline,
  TimelinePoint,
  TitleHistoryPage,
  TitleHistoryRow,
  TopTitle,
  Totals,
  User,
  Viewer,
} from '@/plays/views.js'
