import { Worker } from 'node:worker_threads'
import { session } from '@/db.js'
import * as rollups from '@/rollups.js'

/** One compaction: the file to compact and the instant it is judged against. */
export type CompactJob = Readonly<{
  path: string
  now: Date
}>

/**
 * Run one compaction to completion. The production one is `compactInWorker`;
 * a test passes something synchronous so no worker is ever spawned.
 */
export type Compact = (job: CompactJob) => Promise<void> | void

/**
 * Roll closed buckets up and drop what has outlived its retention.
 *
 * Synchronous on purpose, and never called directly from the loop: runForever
 * hands it to a worker thread. A connection belongs to the thread that opened
 * it, so the session is opened here, inside whichever thread ends up running
 * it.
 */
export const compactAndPrune = ({ path, now }: CompactJob): void => {
  session({
    path,
    work: (connection) => {
      rollups.RESOLUTIONS.forEach((tier) => rollups.compact({ connection, name: tier.name, now }))
      rollups.prune({ connection, now })
    },
  })
}

/**
 * `compactAndPrune` on a worker thread, settled when the worker finishes.
 *
 * The port of `asyncio.to_thread`. better-sqlite3 is synchronous and the event
 * loop is the only thread this process has, so an inline compaction would
 * stall every tick behind it. The worker opens its own session on its own
 * connection, and a compaction that throws there rejects here, exactly as the
 * exception crossed back out of `to_thread`.
 *
 * `nest build` compiles every file under src, so the worker is its compiled
 * sibling in dist.
 */
// Compactions in flight, each as a promise that settles when its thread has
// exited. A shutdown joins them before the process exits, as Python's
// interpreter shutdown joined the to_thread worker: ending a thread that is
// still inside native SQLite code, by worker.terminate() or process.exit(),
// is a V8 fatal error (exit 133), seen on the live 1.8 GB database whenever a
// `docker stop` landed mid-compaction.
const runningCompactions = new Set<Promise<void>>()

export const compactInWorker = ({ path, now }: CompactJob): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./compactWorker.js', import.meta.url), {
      workerData: { path, now: now.getTime() },
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`compaction worker exited with code ${code}`))
      }
    })
  })
  // tracked settled either way, so joining never throws and never leaves a
  // rejection nobody handles; the caller still sees the real outcome on `done`
  const settled = done.then(
    () => undefined,
    () => undefined,
  )
  runningCompactions.add(settled)
  void settled.then(() => runningCompactions.delete(settled))
  return done
}

/**
 * Wait until every compaction thread has finished on its own. A compaction
 * outlasting `docker stop`'s grace period is then killed with the process, the
 * same fate the Python thread met, and SQLite rolls its transaction back.
 */
export const joinCompactions = async (): Promise<void> => {
  await Promise.all(runningCompactions)
}
