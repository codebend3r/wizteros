import { StandardSchemaValidationPipe } from '@nestjs/common'
import { httpError } from '@wizteros/server-common'
import { z } from 'zod'

// Query validation the way FastAPI did it: a parameter that fails its bounds or
// its type is a 422 with a `detail` list, not Nest's 400. The list's entries
// only have to be readable; the portal shows the text and never parses it.

type Issue = Readonly<{ message: string; path?: readonly unknown[] }>

const segment = (part: unknown): unknown =>
  typeof part === 'object' && part !== null && 'key' in part ? part.key : part

/** The route pipe that turns a failed schema into FastAPI's 422. */
export const fastApiValidationPipe = (): StandardSchemaValidationPipe =>
  new StandardSchemaValidationPipe({
    exceptionFactory: (issues: readonly Issue[]) =>
      httpError({
        status: 422,
        detail: issues.map((issue) => ({
          type: 'value_error',
          loc: (issue.path ?? []).map(segment),
          msg: issue.message,
        })),
      }),
  })

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
