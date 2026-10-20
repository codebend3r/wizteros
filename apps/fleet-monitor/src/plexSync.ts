// The play-history loop: Plex's own ledger, read into the store.
//
// Two passes per host, both here and nowhere else. The history pass pages
// `/status/sessions/history/all` from a cursor, enriches every newly seen item
// from `/library/metadata`, and records one check against `plex:<host>`. The
// inventory pass pages every movie, show and artist section so never-played
// has something to diff against.
//
// This is the only module that knows a Plex url. `probes/plex` parses, `plays`
// stores, and the API composes; a request that fails here degrades one host
// for one pass and nothing more. Every page commits in its own session with
// the cursor it advanced, so a pass that dies mid-backfill resumes from the
// last page that landed rather than starting the year over.
//
// Tautulli's answer to the same question is a websocket that has to be
// listening when a play happens, and it cannot see anything from before it was
// installed. The ledger already exists on every server, so it is read instead
// of guessed.

import { inspect } from 'node:util'
import { Logger } from '@nestjs/common'
import {
  dbPath,
  type Host,
  fleetHosts,
  PLEX_HISTORY_INTERVAL,
  PLEX_LIBRARY_INTERVAL,
  plexExcludedPaths,
  plexHosts,
  plexLookbackDays,
  plexToken,
} from '@/config.js'
import { session } from '@/db.js'
import * as incidents from '@/incidents.js'
import type { CheckResult } from '@/incidents.js'
import * as plays from '@/plays/index.js'
import * as plex from '@/probes/plex.js'
import { initDb } from '@/schema.js'
import { every, logRaised } from '@/tasks.js'
import { addSeconds, epochSeconds } from '@wizteros/server-common'
import { getJson, type Send, send } from '@/transport/http.js'

const log = new Logger('fleet.plex')

// Measured 2026-09-18: 500 history rows answer in a tenth of a second and a
// thousand episodes in one to ten, so these are sized for few round trips
// rather than for the server's ceiling.
export const HISTORY_PAGE = 500
export const LIBRARY_PAGE = 1000
// Keys per metadata request. Twenty-five answered in under a second on every
// box; fifty was the batch that took twelve seconds on caraxes under load,
// and a metadata answer is the heaviest thing per item this loop asks for.
export const METADATA_BATCH = 25

const DAY_SECONDS = 86_400

// How far behind the cursor a pass re-reads. Inserts are idempotent on the
// server's own history id, so the overlap costs one cheap page and buys back
// anything a collector outage or a clock step left out.
export const OVERLAP_SECONDS = 2 * DAY_SECONDS

// Wide, on purpose. The first live round timed out at twenty seconds on the
// two slowest boxes while they were also serving streams; the same requests
// answered in a second once they were idle. A dead server fails the connect
// long before this, so the width only ever costs a busy one its patience.
export const TIMEOUT = 90.0

// The incident machine's tolerance for silence between checks. Three history
// intervals, so one slow round does not read as the collector having stopped
// watching and reset the streak that opens an incident.
export const CHECK_GAP_SECONDS = PLEX_HISTORY_INTERVAL * 3

const HISTORY_PATH = '/status/sessions/history/all'

/**
 * True when `path` is the excluded folder or something inside it.
 *
 * Compared on whole segments, so /volume1/Caraxes/tmp never matches a sibling
 * called tmp-restore, and case-insensitively, because the servers spell the
 * same share both ways and the mount is case-preserving either way.
 */
const under = ({ path, folder }: { path: string; folder: string }): boolean => {
  const inside = path.replace(/\/+$/, '').toLowerCase()
  const outer = folder.replace(/\/+$/, '').toLowerCase()
  return inside === outer || inside.startsWith(`${outer}/`)
}

/**
 * The section ids whose every folder sits under an excluded one.
 *
 * Every, not any: a library pointed at both a scratch folder and a real one
 * is a library the page still has to count, and dropping it whole because one
 * of its paths matched would lose plays nobody asked to lose. A section with
 * no folder at all is never excluded, since there is no path to judge.
 */
export const excludedSections = ({
  sections,
  folders,
}: {
  sections: readonly plex.Section[]
  folders: readonly string[]
}): ReadonlySet<string> =>
  new Set(
    sections
      .filter(
        (section) =>
          section.locations.length > 0 &&
          section.locations.every((path) => folders.some((folder) => under({ path, folder }))),
      )
      .map((section) => section.section_id),
  )

/**
 * One Plex answer, decoded, or the reason there is none. `reason` names the
 * transport failure the way the docker endpoint's checks do, plus `bad_json`
 * for a 200 nothing could parse or that carried a bare JSON `null`.
 */
export type Fetched =
  | Readonly<{ ok: true; payload: unknown }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Whether the server said something the caller can act on.
 *
 * A 404 is the server saying what was asked for does not exist any more,
 * which is an answer: the enrichment stubs those keys and moves on. Anything
 * else that failed is the server not answering, which is not the same fact
 * and ends the pass. Stated once because both enrichment paths have to draw
 * the line in the same place.
 */
const answeredOrGone = (fetched: Fetched): boolean => fetched.ok || fetched.reason === 'http_404'

/** What an answer described, or nothing for a key the server has forgotten. */
const payloadOf = (fetched: Fetched): unknown => (fetched.ok ? fetched.payload : null)

/**
 * What one round did for one host: whether the history pass succeeded and
 * whether an inventory ran to completion. Only the loop reads it, to decide
 * when the next inventory is due.
 */
export type HostOutcome = Readonly<{
  history_ok: boolean
  inventory_ran: boolean
  inventory_complete: boolean
}>

/**
 * How a pass reaches Plex: the wire it sends on, the budget each request
 * gets, and the signal that abandons a request in flight. Production passes
 * nothing and gets `send`, TIMEOUT and no signal; a test stands in for the
 * server at the wire and narrows the budget (the Python tests patched
 * `http.get_json` and `TIMEOUT` on the module, which an ESM export does not
 * allow), and `runForever` hands its shutdown signal down.
 */
export type Transport = Readonly<{
  send: Send
  timeout: number
  signal: AbortSignal | null
}>

export const transport = ({
  send: wire = send,
  timeout = TIMEOUT,
  signal = null,
}: {
  send?: Send
  timeout?: number
  signal?: AbortSignal | null
} = {}): Transport => ({ send: wire, timeout, signal })

const secure = (host: Host): boolean => host.plex_url.startsWith('https://')

// Python's quote_plus with `safe=">:,"`: letters, digits and `_.-~` stay, a
// space becomes `+`, and `>`, `:` and `,` stay literal. encodeURIComponent
// also leaves `!'()*` alone, which quote_plus escapes, so those are escaped
// back.
const quotePlus = (text: string): string =>
  encodeURIComponent(text)
    .replace(/[!'()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')
    .replace(/%(3E|3A|2C)/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

/** Python's `urlencode(params, safe=">:,")`, in the order the params were given. */
const urlencode = (params: Readonly<Record<string, string>>): string =>
  Object.entries(params)
    .map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`)
    .join('&')

/** One GET a pass asks of its server: the path, its query, and the page wanted. */
export type PlexRequest = Readonly<{
  path: string
  params?: Readonly<Record<string, string>>
  start?: number
  size?: number
}>

/**
 * One Plex server as a pass sees it: the host it is, and a GET that already
 * carries the token and the transport. Built once per host per pass, so
 * nothing below has to hand the four of them along.
 */
export type PlexClient = Readonly<{
  host: Host
  get: (request: PlexRequest) => Promise<Fetched>
}>

/**
 * The client for one server. Its `get` fetches one Plex path as JSON, never
 * failing on the server's account, within the transport's budget.
 *
 * Paging travels in the two container headers, the way every Plex client
 * sends it. The query keeps `>` and `:` literal because `viewedAt>=` and
 * `viewedAt:asc` are how the server spells its own filters.
 *
 * Verification is off for the two servers that insist on https: they present
 * Plex's wildcard certificate on a LAN address, which no verifier accepts,
 * and the token is what authorizes the request on either transport.
 *
 * The whole request gets the budget, headers to last byte, so a server that
 * keeps trickling bytes cannot hold a five-server loop for an hour.
 *
 * A 200 carrying a bare JSON `null` is a failure named `bad_json`: there is
 * nothing in it to store, and reading it as an answer let a pass report
 * success having committed nothing.
 *
 * The one rejection is the transport's signal aborting, which is a shutdown
 * rather than the server failing: `getJson` surfaces it as an AbortError,
 * which `logRaised` passes through, so a round torn down mid-request records
 * no failed check against a server that did nothing wrong. Python's task
 * cancellation did the same.
 */
export const plexClient = ({
  host,
  token,
  via = transport(),
}: {
  host: Host
  token: string
  via?: Transport
}): PlexClient => ({
  host,
  get: async ({ path, params = {}, start, size }) => {
    const query = urlencode(params)
    const result = await getJson({
      url: `${host.plex_url}${path}${query ? `?${query}` : ''}`,
      timeout: via.timeout,
      headers: {
        'X-Plex-Token': token,
        Accept: 'application/json',
        ...(start === undefined ? {} : { 'X-Plex-Container-Start': String(start) }),
        ...(size === undefined ? {} : { 'X-Plex-Container-Size': String(size) }),
      },
      verify: !secure(host),
      signal: via.signal,
      get: via.send,
    })
    return result.ok && result.payload === null ? { ok: false, reason: 'bad_json' } : result
  },
})

/**
 * Record a history pass that could not complete, against the server it could
 * not read. The rows already committed stay: a pass that died on page four
 * keeps pages one to three, and the cursor says so.
 */
const failed = ({
  host,
  path,
  at,
  reason,
}: {
  host: Host
  path: string
  at: Date
  reason: string
}): CheckResult => {
  const check = incidents.checkResult({ target: `plex:${host.name}`, ok: false, reason })
  session({
    path,
    work: (connection) => {
      plays.markHistory({ connection, host: host.name, at, ok: false, error: reason })
      incidents.record({ connection, result: check, at, gap: CHECK_GAP_SECONDS })
    },
  })
  log.warn(`play history for ${host.name} failed: ${reason}`)
  return check
}

/**
 * Page one Plex listing from `start` to its end, handing each page to `keep`
 * before asking for the next. Returns the failure reason, or empty when the
 * last page landed.
 *
 * Each page is kept, and so committed, before the next is asked for, which is
 * what lets a pass that dies midway resume from the last page that landed.
 */
const pageAll = async ({
  client,
  request,
  pageSize,
  keep,
  start = 0,
}: {
  client: PlexClient
  request: Omit<PlexRequest, 'start' | 'size'>
  pageSize: number
  keep: (payload: unknown) => void
  start?: number
}): Promise<string> => {
  const fetched = await client.get({ ...request, start, size: pageSize })
  if (!fetched.ok) {
    return fetched.reason
  }
  keep(fetched.payload)
  const info = plex.pageInfo(fetched.payload)
  if (info === null || info.size === 0 || start + info.size >= info.total_size) {
    return ''
  }
  return pageAll({ client, request, pageSize, keep, start: start + info.size })
}

/**
 * Page the ledger from `since` upward, committing each page with the cursor
 * it advanced. Returns the failure reason, or empty when the last page
 * landed.
 *
 * Ascending, so the cursor only ever moves forward and a page that commits is
 * a page nobody has to read again. A play landing on the server while the
 * pass runs appends past the last page rather than shifting the pages already
 * read.
 *
 * A play in an excluded library is dropped before it is stored, but it still
 * moves the cursor: the page was read, and re-reading it next pass would only
 * drop the same rows again.
 */
const pageHistory = ({
  client,
  path,
  since,
  pageSize,
  excluded,
}: {
  client: PlexClient
  path: string
  since: number
  pageSize: number
  excluded: ReadonlySet<string>
}): Promise<string> =>
  pageAll({
    client,
    request: { path: HISTORY_PATH, params: { sort: 'viewedAt:asc', 'viewedAt>': String(since) } },
    pageSize,
    keep: (payload) => {
      const host = client.host.name
      const entries = plex.parseHistory(payload)
      const kept = entries.filter(
        (entry) => entry.section_id === null || !excluded.has(entry.section_id),
      )
      const inserted = session({
        path,
        work: (connection) => {
          const count = plays.insertPlays({ connection, host, plays: kept })
          if (entries.length > 0) {
            plays.setHistoryCursor({
              connection,
              host,
              cursor: entries.reduce(
                (newest, entry) => Math.max(newest, entry.viewed_at),
                -Infinity,
              ),
            })
          }
          return count
        },
      })
      if (inserted) {
        log.log(`play history for ${host}: ${inserted} new plays`)
      }
    },
  })

/** Keep what a metadata request described and stub what it did not. */
const storeAnswered = ({
  path,
  host,
  now,
  keys,
  payload,
}: {
  path: string
  host: Host
  now: Date
  keys: readonly string[]
  payload: unknown
}): void => {
  const items = payload === null ? [] : plex.parseItems({ payload })
  const answered: ReadonlySet<string> = new Set(items.map((item) => item.rating_key))
  session({
    path,
    work: (connection) => {
      plays.upsertItems({ connection, host: host.name, items, seenAt: now })
      plays.stubMissingItems({
        connection,
        host: host.name,
        keys: keys.filter((key) => !answered.has(key)),
        seenAt: now,
      })
    },
  })
}

/**
 * The fallback for a batch that stalled: one request per key, in order. A key
 * that stalls alone is stubbed as absent so the loop moves past it; any other
 * failure is the server not answering and ends the pass as usual, leaving the
 * keys after it unasked.
 */
const enrichSingly = ({
  client,
  path,
  now,
  keys,
}: {
  client: PlexClient
  path: string
  now: Date
  keys: readonly string[]
}): Promise<string> =>
  keys.reduce<Promise<string>>(async (previous, key) => {
    const reason = await previous
    if (reason) {
      return reason
    }
    const { host } = client
    const fetched = await client.get({ path: `/library/metadata/${key}` })
    if (!fetched.ok && fetched.reason === 'timeout') {
      log.warn(`metadata for ${host.name} item ${key} stalled on its own; stubbed`)
      storeAnswered({ path, host, now, keys: [key], payload: null })
      return ''
    }
    if (!fetched.ok && !answeredOrGone(fetched)) {
      return fetched.reason
    }
    storeAnswered({ path, host, now, keys: [key], payload: payloadOf(fetched) })
    return ''
  }, Promise.resolve(''))

/**
 * Give every played item with no row one: titles for the page, quality for
 * the buckets. Returns the failure reason, or empty when nothing is missing.
 *
 * Keys the server does not answer for get a stub, so a deleted film is asked
 * about once rather than on every pass. Each batch shrinks the missing set,
 * so this always terminates.
 */
const enrichItems = async ({
  client,
  path,
  now,
}: {
  client: PlexClient
  path: string
  now: Date
}): Promise<string> => {
  const { host } = client
  const keys = session({
    path,
    mode: 'read',
    work: (connection) =>
      plays.missingItemKeys({ connection, host: host.name, limit: METADATA_BATCH }),
  })
  if (keys.length === 0) {
    return ''
  }
  const fetched = await client.get({ path: `/library/metadata/${keys.join(',')}` })
  if (!fetched.ok && fetched.reason === 'timeout') {
    // One key can stall a whole batch, and the batch is retried in the same
    // order on every pass, so a stalled key would block every item behind it
    // forever. Ask for each alone: the ones that answer are kept, the one
    // that stalls on its own is stubbed and named, and the next inventory
    // restores it if the library still has it.
    const reason = await enrichSingly({ client, path, now, keys })
    if (reason) {
      return reason
    }
    return enrichItems({ client, path, now })
  }
  if (!fetched.ok && !answeredOrGone(fetched)) {
    return fetched.reason
  }
  storeAnswered({ path, host, now, keys, payload: payloadOf(fetched) })
  return enrichItems({ client, path, now })
}

/**
 * One host's history pass. Null for a host without Plex; otherwise the check
 * that was recorded, which is the pass's outcome.
 *
 * The order matters: the server is identified first, so a pass that fails at
 * the first request still leaves a named row on /plays/sync; identities are
 * refreshed next, best effort, so a viewer's name is known before their plays
 * are shown; then the ledger, then the items behind it.
 *
 * `enrich` is off on a round that is about to take the inventory: the listing
 * describes every item still in the library far more cheaply than the
 * metadata endpoint does, so the round enriches only what the listing left
 * out, afterwards.
 */
export const syncHistory = async ({
  host,
  path,
  now,
  token,
  lookbackDays,
  pageSize = HISTORY_PAGE,
  enrich = true,
  via = transport(),
}: {
  host: Host
  path: string
  now: Date
  token: string
  lookbackDays: number
  pageSize?: number
  enrich?: boolean
  via?: Transport
}): Promise<CheckResult | null> => {
  if (!host.plex_url) {
    return null
  }
  if (!token) {
    return failed({ host, path, at: now, reason: 'no_token' })
  }
  const client = plexClient({ host, token, via })

  const root = await client.get({ path: '/' })
  if (!root.ok) {
    return failed({ host, path, at: now, reason: root.reason })
  }
  const info = plex.parseServer(root.payload)
  if (info === null) {
    return failed({ host, path, at: now, reason: 'bad_json' })
  }
  const [cursor, excluded] = session({
    path,
    work: (connection) => {
      plays.upsertServer({ connection, host: host.name, info })
      return [
        plays.historyCursor({ connection, host: host.name }),
        plays.excludedSectionIds({ connection, host: host.name }),
      ] as const
    },
  })

  const accounts = await client.get({ path: '/accounts' })
  const devices = await client.get({ path: '/devices' })
  session({
    path,
    work: (connection) => {
      if (accounts.ok) {
        plays.upsertAccounts({
          connection,
          host: host.name,
          accounts: plex.parseAccounts(accounts.payload),
        })
      }
      if (devices.ok) {
        plays.upsertDevices({
          connection,
          host: host.name,
          devices: plex.parseDevices(devices.payload),
        })
      }
    },
  })

  const since =
    cursor !== null
      ? cursor - OVERLAP_SECONDS
      : epochSeconds(addSeconds({ at: now, seconds: -lookbackDays * DAY_SECONDS }))
  const paged = await pageHistory({ client, path, since, pageSize, excluded })
  if (paged) {
    return failed({ host, path, at: now, reason: paged })
  }
  if (enrich) {
    const reason = await enrichItems({ client, path, now })
    if (reason) {
      return failed({ host, path, at: now, reason })
    }
  }

  const check = incidents.checkResult({ target: `plex:${host.name}`, ok: true, reason: '' })
  session({
    path,
    work: (connection) => {
      plays.markHistory({ connection, host: host.name, at: now, ok: true, error: null })
      incidents.record({ connection, result: check, at: now, gap: CHECK_GAP_SECONDS })
    },
  })
  return check
}

/**
 * Every leaf item of one section, a page per session, all stamped with this
 * run. Returns the failure reason, or empty when the last page landed.
 */
const pageSection = ({
  client,
  path,
  section,
  now,
  pageSize,
}: {
  client: PlexClient
  path: string
  section: plex.Section
  now: Date
  pageSize: number
}): Promise<string> =>
  pageAll({
    client,
    request: {
      path: `/library/sections/${section.section_id}/all`,
      params: { type: String(plex.LEAF_TYPE[section.kind]), includeGuids: '0' },
    },
    pageSize,
    keep: (payload) => {
      // the listing does not name its own section on each row
      const items = plex.parseItems({ payload, sectionId: section.section_id })
      session({
        path,
        work: (connection) =>
          plays.upsertItems({ connection, host: client.host.name, items, seenAt: now }),
      })
    },
  })

/**
 * One host's inventory pass. True when every section paged to its end.
 *
 * Items are retired only after a complete run. A section that failed on page
 * three left its remaining items unseen this run, and retiring them would
 * make a third of a library look deleted because a request timed out.
 *
 * This is also where the exclusion rule is applied, because this is the one
 * pass that reads the section listing and so the one that can tell which
 * library sits in an excluded folder. Excluded sections are marked, their
 * plays and items deleted, and their listings never paged, so the history
 * pass that runs before the next inventory already knows to drop them.
 */
export const syncLibrary = async ({
  host,
  path,
  now,
  token,
  pageSize = LIBRARY_PAGE,
  via = transport(),
}: {
  host: Host
  path: string
  now: Date
  token: string
  pageSize?: number
  via?: Transport
}): Promise<boolean> => {
  if (!host.plex_url || !token) {
    return false
  }
  const client = plexClient({ host, token, via })
  const sections = await client.get({ path: '/library/sections' })
  if (!sections.ok) {
    session({
      path,
      work: (connection) =>
        plays.markLibrary({
          connection,
          host: host.name,
          at: now,
          ok: false,
          error: sections.reason,
        }),
    })
    log.warn(`inventory for ${host.name} failed: ${sections.reason}`)
    return false
  }
  const parsed = plex.parseSections(sections.payload)
  const excluded = excludedSections({ sections: parsed, folders: plexExcludedPaths() })
  const purged = session({
    path,
    work: (connection) => {
      plays.upsertSections({ connection, host: host.name, sections: parsed, excludedIds: excluded })
      return plays.purgeSections({ connection, host: host.name, sectionIds: excluded })
    },
  })
  if (purged.plays || purged.items) {
    log.log(
      `inventory for ${host.name} purged ${purged.plays} plays and ${purged.items} items ` +
        'from excluded libraries',
    )
  }

  // One section after another, and every one of them even after a failure;
  // the failure kept is the last one, as the Python loop overwrote it.
  const failure = await parsed.reduce<Promise<string>>(async (previous, section) => {
    const earlier = await previous
    if (excluded.has(section.section_id)) {
      return earlier
    }
    const reason = await pageSection({ client, path, section, now, pageSize })
    if (reason) {
      log.warn(`inventory for ${host.name} stopped in '${section.title}': ${reason}`)
      return reason
    }
    return earlier
  }, Promise.resolve(''))
  const complete = !failure
  session({
    path,
    work: (connection) => {
      if (complete) {
        const retired = plays.retireUnseenItems({ connection, host: host.name, seenBefore: now })
        if (retired) {
          log.log(`inventory for ${host.name} retired ${retired} items`)
        }
      }
      plays.markLibrary({
        connection,
        host: host.name,
        at: now,
        ok: complete,
        error: failure || null,
      })
    },
  })
  return complete
}

/**
 * One host's round: history always, inventory when due and only after a
 * history pass that reached the server. Sequential within the host, so one
 * server never answers two of this loop's requests at once.
 *
 * On an inventory round the played items are enriched after the listing
 * rather than before it. On a fresh database that is the difference between
 * asking the metadata endpoint about every item ever played and asking it
 * about the handful the library no longer holds.
 */
export const syncHost = async ({
  host,
  path,
  now,
  token,
  lookbackDays,
  inventoryDue,
  via = transport(),
}: {
  host: Host
  path: string
  now: Date
  token: string
  lookbackDays: number
  inventoryDue: boolean
  via?: Transport
}): Promise<HostOutcome> => {
  const check = await syncHistory({
    host,
    path,
    now,
    token,
    lookbackDays,
    enrich: !inventoryDue,
    via,
  })
  const historyOk = check !== null && check.ok
  if (!(inventoryDue && historyOk)) {
    return { history_ok: historyOk, inventory_ran: false, inventory_complete: false }
  }
  const complete = await syncLibrary({ host, path, now, token, via })
  const reason = await enrichItems({ client: plexClient({ host, token, via }), path, now })
  if (reason) {
    // the ledger and the library both landed; what is missing is the detail
    // of a few deleted items, which the next pass asks for again
    log.warn(`enrichment for ${host.name} stopped: ${reason}`)
  }
  return { history_ok: historyOk, inventory_ran: true, inventory_complete: complete }
}

/**
 * Every Plex host concurrently. The token is read per round rather than once
 * at start, so a token added to the env after boot is picked up by the next
 * pass without a restart.
 *
 * `hosts` is the whole fleet, narrowed to its Plex hosts here, and defaults to
 * the config's; the Python tests patched `config.fleetHosts` instead. A host whose
 * round rejected is logged by `logRaised` and left out of the answer; an
 * abort is rethrown by it, which is how a shutdown ends the round.
 */
export const runRound = async ({
  path,
  now,
  inventoryDue,
  hosts = fleetHosts(),
  via = transport(),
}: {
  path: string
  now: Date
  inventoryDue: ReadonlySet<string>
  hosts?: readonly Host[]
  via?: Transport
}): Promise<Readonly<Record<string, HostOutcome>>> => {
  const token = plexToken()
  const lookback = plexLookbackDays()
  const outcomes = await Promise.allSettled(
    plexHosts(hosts).map(
      async (host) =>
        [
          host.name,
          await syncHost({
            host,
            path,
            now,
            token,
            lookbackDays: lookback,
            inventoryDue: inventoryDue.has(host.name),
            via,
          }),
        ] as const,
    ),
  )
  return Object.fromEntries(logRaised({ label: 'play history', outcomes }))
}

/** The loop's clock: monotonic seconds, like asyncio's `loop.time()`. */
const monotonic = (): number => performance.now() / 1000

/**
 * History every PLEX_HISTORY_INTERVAL, an inventory per host every
 * PLEX_LIBRARY_INTERVAL, the first one on the first round.
 *
 * A failed inventory is retried on the next history round rather than in six
 * hours: the failure was one request, and a library that never gets counted
 * is a never-played list that never appears.
 *
 * `signal` is the shutdown. It abandons the request in flight and the sleep
 * between rounds, and the loop then returns rather than throwing, so SIGTERM
 * stops it within a moment. Python cancelled the task instead. Every page
 * commits in its own session, so an abandoned pass loses nothing that landed.
 */
export const runForever = async ({
  path,
  signal = new AbortController().signal,
}: {
  path: string
  signal?: AbortSignal
}): Promise<void> => {
  initDb(path)
  if (!plexToken()) {
    log.warn('no Plex token in FM_PLEX_TOKEN or PLEX_TOKEN; play history idles until one appears')
  }
  const via = transport({ signal })
  let inventoryNext: ReadonlyMap<string, number> = new Map(
    plexHosts().map((host) => [host.name, 0] as const),
  )
  await every({
    seconds: PLEX_HISTORY_INTERVAL,
    signal,
    round: async () => {
      const now = new Date()
      const inventoryDue = new Set(
        [...inventoryNext].filter(([, at]) => monotonic() >= at).map(([name]) => name),
      )
      const outcomes = await runRound({ path, now, inventoryDue, via })
      inventoryNext = new Map([
        ...inventoryNext,
        ...Object.entries(outcomes)
          .filter(([, outcome]) => outcome.inventory_complete)
          .map(([name]) => [name, monotonic() + PLEX_LIBRARY_INTERVAL] as const),
      ])
    },
  })
}

/**
 * One round with the inventory on every host, for a first fill by hand or a
 * smoke test. The same code the loop runs, minus the sleeping.
 */
export const runOnce = async ({
  path,
  hosts = fleetHosts(),
  via = transport(),
}: {
  path: string
  hosts?: readonly Host[]
  via?: Transport
}): Promise<Readonly<Record<string, HostOutcome>>> => {
  initDb(path)
  return runRound({
    path,
    now: new Date(),
    inventoryDue: new Set(plexHosts(hosts).map((host) => host.name)),
    hosts,
    via,
  })
}

// `node dist/plexSync.js` runs one round and exits, as `python -m
// fleet_monitor.plex_sync` did; the collector's own entrypoint is what runs it
// forever beside the vitals.
if (import.meta.main) {
  const outcomes = await runOnce({ path: dbPath() })
  Object.entries(outcomes).forEach(([name, result]) => {
    process.stdout.write(`${name} ${inspect(result)}\n`)
  })
}
