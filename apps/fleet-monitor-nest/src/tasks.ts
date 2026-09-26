import { Logger } from '@nestjs/common'

const log = new Logger('fleet.tasks')

// An abort is the process being torn down, not a job failing, and swallowing
// it would make a graceful shutdown impossible.
const isAbort = (reason: unknown): boolean =>
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
