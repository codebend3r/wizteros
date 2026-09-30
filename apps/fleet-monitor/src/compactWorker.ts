import { workerData } from 'node:worker_threads'
import { compactAndPrune } from '@/collector.js'

// The worker thread behind `compactInWorker`: one compaction, then exit.
//
// It opens its own session inside `compactAndPrune`, on a connection of its
// own, so the blocking SQLite work never touches the event loop the ticks run
// on. A throw here is an uncaught error in the worker, which the main thread
// receives as the rejection of the compaction it is awaiting.

// The job the main thread posted. `now` crosses as epoch milliseconds, and
// workerData arrives untyped, so it is narrowed rather than trusted.
type Job = Readonly<{ path: string; now: number }>

const isJob = (value: unknown): value is Job =>
  typeof value === 'object' &&
  value !== null &&
  'path' in value &&
  typeof value.path === 'string' &&
  'now' in value &&
  typeof value.now === 'number'

const job: unknown = workerData

if (!isJob(job)) {
  throw new TypeError('the compaction worker needs a { path, now } job')
}

compactAndPrune({ path: job.path, now: new Date(job.now) })
