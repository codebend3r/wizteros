import { Logger } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'

const log = new Logger('fleet.tasks')

/**
 * Whether a rejection is the process being torn down rather than a job
 * failing. Swallowing one would make a graceful shutdown impossible, so it is
 * the one rejection a stopping loop returns on rather than raises.
 */
export const isAbort = (reason: unknown): boolean =>
  reason instanceof Error && reason.name === 'AbortError'

/**
 * Name any job that rejected and return only the values the others produced.
 *
 * Promise.allSettled is what keeps one wedged host from taking a whole round
 * down, but a swallowed rejection is a silent hole, so every one of them is
 * logged here before being dropped. An abort is rethrown instead.
 *
 * Shared by the vitals loop and the play-history loop, which run side by side
 * in one process and must treat a torn-down task the same way.
 */
export const logRaised = <T>({
  label,
  outcomes,
}: {
  label: string
  outcomes: readonly PromiseSettledResult<T>[]
}): T[] => {
  const reasons = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  )
  const fatal = reasons.find(isAbort)
  if (fatal !== undefined) {
    throw fatal
  }
  if (reasons.length > 0) {
    log.warn(`${label}: ${reasons.length} job(s) raised: ${reasons.map(String).join('; ')}`)
  }
  return outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []))
}

/**
 * Run `round` every `seconds` until `signal` aborts, one round at a time.
 *
 * Each round is due a fixed interval after the one before it was due, not
 * after it finished, so a long round (a first backfill, a slow ssh capture)
 * is absorbed rather than added to every interval after it. `round` is
 * handed its index, counting from 0.
 *
 * Returns once `signal` aborts, from whichever await it was at; a failure of
 * anything else still rejects, as it raised out of the Python loop.
 */
export const every = async ({
  seconds,
  signal,
  round,
}: {
  seconds: number
  signal: AbortSignal
  round: (index: number) => Promise<void>
}): Promise<void> => {
  // the loop's own state, in milliseconds on the monotonic clock. A while
  // loop and two counters rather than recursion: this never ends, and an
  // async function that returns its own next call holds every earlier
  // round's promise for as long as the process lives
  let due = performance.now()
  let rounds = 0
  try {
    while (!signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- each round is due only after the one before it
      await round(rounds)
      rounds += 1
      due += seconds * 1000
      // oxlint-disable-next-line no-await-in-loop -- the wait between rounds is the loop's whole cadence
      await sleep(Math.max(0, due - performance.now()), undefined, { signal })
    }
  } catch (error) {
    if (!(signal.aborted && isAbort(error))) {
      throw error
    }
  }
}
