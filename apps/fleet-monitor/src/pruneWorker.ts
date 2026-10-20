import { workerData } from 'node:worker_threads'
import { pruneSamples } from '@/retention.js'

// The worker thread behind `pruneInWorker`: one prune, then exit.
//
// It opens its own session inside `pruneSamples`, on a connection of its
// own, so the blocking SQLite work never touches the event loop the ticks run
// on. A throw here is an uncaught error in the worker, which the main thread
// receives as the rejection of the prune it is awaiting.

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
  throw new TypeError('the prune worker needs a { path, now } job')
}

pruneSamples({ path: job.path, now: new Date(job.now) })
