import { Logger } from '@nestjs/common'
import { stackOf } from '@/errors.js'

const log = new Logger('bridge.snapshot')

/**
 * The last known result of a slow fetch, refreshed off the request path.
 *
 * get() serves the stored value instantly and only waits on the very first
 * call (nothing cached yet). The app's lifecycle loop warms the value at boot
 * and re-fetches it on an interval, and refreshAsync() re-fetches after admin
 * actions that change upstream state. A failed refresh logs and keeps serving
 * the previous value.
 *
 * The Python ran the background refresh on a thread and guarded the value and
 * the in-flight flag with a lock. Node runs this code on one thread, so no
 * read or write here can interleave with another: a single in-flight promise
 * is both the flag and the handle settled() awaits.
 *
 * As in Python, a fetch answering null or undefined counts as nothing cached.
 */
export class UpstreamSnapshot<T> {
  private readonly fetch: () => Promise<T>
  private value: T | null = null
  private inFlight: Promise<void> | null = null

  constructor({ fetch }: { fetch: () => Promise<T> }) {
    this.fetch = fetch
  }

  /** Whether a background refresh is running right now. */
  get refreshing(): boolean {
    return this.inFlight !== null
  }

  /** The cached value, fetching now only when nothing is cached yet. */
  async get(): Promise<T> {
    return this.value ?? this.refresh()
  }

  /** Fetch now, store the result, and return it. Rejects if the fetch fails, keeping the old value. */
  async refresh(): Promise<T> {
    const value = await this.fetch()
    this.value = value
    return value
  }

  /** Kick one background refresh; a no-op while another is already running. */
  refreshAsync(): void {
    if (this.inFlight !== null) {
      return
    }
    /** Refresh once, swallowing failures so the previous value keeps serving. */
    const run = async (): Promise<void> => {
      try {
        await this.refresh()
      } catch (error) {
        log.error('background snapshot refresh failed; serving previous value', stackOf(error))
      } finally {
        this.inFlight = null
      }
    }
    // run() cannot reach its finally before this assignment: refresh() awaits
    // the fetch, which always yields at least once.
    this.inFlight = run()
  }

  /** Resolves once any in-flight background refresh has finished, for tests and shutdown. */
  async settled(): Promise<void> {
    await this.inFlight
  }

  /** Drop the cached value so the next get() fetches fresh (used by tests). */
  clear(): void {
    this.value = null
  }
}
