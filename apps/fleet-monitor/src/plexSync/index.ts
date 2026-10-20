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
  plexHosts,
  plexLookbackDays,
  plexToken,
} from '@/config.js'
import { plexClient, type Transport, transport } from '@/plexSync/client.js'
import { enrichItems, syncHistory } from '@/plexSync/history.js'
import { syncLibrary } from '@/plexSync/inventory.js'
import { initDb } from '@/schema.js'
import { every, logRaised } from '@/tasks.js'

export {
  type Fetched,
  type PlexClient,
  plexClient,
  type PlexRequest,
  TIMEOUT,
  type Transport,
  transport,
} from '@/plexSync/client.js'
export {
  CHECK_GAP_SECONDS,
  HISTORY_PAGE,
  METADATA_BATCH,
  OVERLAP_SECONDS,
  syncHistory,
} from '@/plexSync/history.js'
export { excludedSections, LIBRARY_PAGE, syncLibrary } from '@/plexSync/inventory.js'

const log = new Logger('fleet.plex')

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

// `node dist/plexSync/index.js` runs one round and exits, as `python -m
// fleet_monitor.plex_sync` did; the collector's own entrypoint is what runs it
// forever beside the vitals.
if (import.meta.main) {
  const outcomes = await runOnce({ path: dbPath() })
  Object.entries(outcomes).forEach(([name, result]) => {
    process.stdout.write(`${name} ${inspect(result)}\n`)
  })
}
