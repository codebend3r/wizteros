import { Logger } from '@nestjs/common'
import { joinCompactions, runAll } from '@/collector.js'
import { dbPath, SLOW_INTERVAL, VITALS_INTERVAL } from '@/config.js'

// `node dist/collectorMain.js`, the port of `python -m fleet_monitor.collector`:
// runs the loops against the same database the API reads. Where and how it is
// actually scheduled is a deployment decision, and deliberately not one this
// module makes. It needs nothing from Nest but the logger, so it builds no
// module and no container.

const log = new Logger('fleet.collector')

const stackOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error)

const controller = new AbortController()

// `once`, so a second signal falls through to Node's default and ends the
// process outright, the way an impatient second Ctrl-C should
const stop = (signal: NodeJS.Signals): void => {
  log.log(`${signal} received, stopping`)
  controller.abort()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)

const path = dbPath()
log.log(
  `collecting into ${path}: vitals every ${VITALS_INTERVAL}s, slow tier every ${SLOW_INTERVAL}s`,
)

try {
  await runAll({ path, signal: controller.signal })
  log.log('stopped')
} catch (error) {
  // either loop failing ends the process, as the Python gather raised out of
  // asyncio.run; the other loop is stopped rather than left running alone
  log.error(stackOf(error))
  controller.abort()
  process.exitCode = 1
}

// A compaction thread has to finish before the process exits: exiting under a
// worker still inside native SQLite code crashes V8.
await joinCompactions()

// A stopped loop stops waiting, but other work it abandoned mid-round (an ssh
// capture, a Plex page) runs on to its own timeout and would hold the process
// open past `docker stop`'s grace period. Nothing awaits it any more, and
// every write it could still make commits whole or not at all, so the process
// leaves now.
process.exit()
