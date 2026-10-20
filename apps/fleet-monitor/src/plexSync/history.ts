// The history pass: the server's identity, its accounts and devices, the
// ledger paged from a cursor, and the metadata behind every newly played item.

import { Logger } from '@nestjs/common'
import { type Host, PLEX_HISTORY_INTERVAL } from '@/config.js'
import { session } from '@/db.js'
import * as incidents from '@/incidents.js'
import type { CheckResult } from '@/incidents.js'
import * as plays from '@/plays/index.js'
import * as plex from '@/probes/plex.js'
import { addSeconds, epochSeconds } from '@wizteros/server-common'
import {
  answeredOrGone,
  pageAll,
  payloadOf,
  type PlexClient,
  plexClient,
  type Transport,
  transport,
} from '@/plexSync/client.js'

const log = new Logger('fleet.plex')

// Measured 2026-09-18: 500 history rows answer in a tenth of a second and a
// thousand episodes in one to ten, so these are sized for few round trips
// rather than for the server's ceiling.
export const HISTORY_PAGE = 500
// Keys per metadata request. Twenty-five answered in under a second on every
// box; fifty was the batch that took twelve seconds on caraxes under load,
// and a metadata answer is the heaviest thing per item this loop asks for.
export const METADATA_BATCH = 25

const DAY_SECONDS = 86_400

// How far behind the cursor a pass re-reads. Inserts are idempotent on the
// server's own history id, so the overlap costs one cheap page and buys back
// anything a collector outage or a clock step left out.
export const OVERLAP_SECONDS = 2 * DAY_SECONDS

// The incident machine's tolerance for silence between checks. Three history
// intervals, so one slow round does not read as the collector having stopped
// watching and reset the streak that opens an incident.
export const CHECK_GAP_SECONDS = PLEX_HISTORY_INTERVAL * 3

const HISTORY_PATH = '/status/sessions/history/all'

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
export const enrichItems = async ({
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
