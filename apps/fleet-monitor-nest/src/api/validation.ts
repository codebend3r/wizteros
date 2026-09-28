import { z } from 'zod'

// Query parameter schemas with FastAPI's parsing rules. The 422 they fail with
// comes from fastApiValidationPipe in @wizteros/server-common.

// FastAPI parsed an `int` query strictly: `6e1`, `2.5` and `` are refused,
// where Number() would read the first two as numbers and the last as zero.
const INTEGER = /^\s*[+-]?\d+\s*$/

/**
 * An integer query parameter with FastAPI's `ge`/`le` bounds and an optional
 * default, e.g. `Query(default=60, ge=2, le=10080)`.
 */
export const intQuery = ({
  fallback,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
}: {
  fallback?: number
  min?: number
  max?: number
}) => {
  const parsed = z
    .string()
    .regex(INTEGER, 'Input should be a valid integer')
    .transform((text) => Number.parseInt(text, 10))
    .pipe(z.number().int().min(min).max(max))
  return fallback === undefined ? parsed : parsed.optional().transform((value) => value ?? fallback)
}

/** A text query parameter with FastAPI's `min_length`/`max_length`. */
export const textQuery = ({ min = 0, max }: { min?: number; max: number }) =>
  z.string().min(min).max(max)
