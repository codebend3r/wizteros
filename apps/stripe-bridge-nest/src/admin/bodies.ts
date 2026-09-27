import { z } from 'zod'

// The admin routes' query and body schemas, with pydantic v2's lax-mode
// coercion for the field types the Python models used. The portal only ever
// sends the right types, but a hand-written curl or a stale portal build
// must be accepted or refused exactly as FastAPI did. A failed schema is
// FastAPI's 422 through fastApiValidationPipe; extra fields are ignored, as
// pydantic's default `extra="ignore"` did, which zod's object already does.

// pydantic's int from a string: surrounding whitespace, one sign, digits with
// single underscores between them, and a zero-only fraction (`"1.0"`).
const INT_TEXT = /^[+-]?\d+(?:_\d+)*(?:\.0+)?$/

// The strings pydantic reads as a bool, compared lowercased with no trimming.
const TRUE_TEXT: ReadonlySet<string> = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const FALSE_TEXT: ReadonlySet<string> = new Set(['0', 'f', 'false', 'n', 'no', 'off'])

// Past this a float no longer names one integer, where pydantic refuses it.
const INT_LIMIT = 2 ** 63

/** pydantic's lax int, or undefined when it would refuse the value. */
const laxInt = (value: unknown): number | undefined => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) < INT_LIMIT ? value + 0 : undefined
  }
  if (typeof value === 'string') {
    const text = value.trim()
    // `+ 0` turns a parsed "-0" into 0, as Python's int has no negative zero.
    return INT_TEXT.test(text) ? Number.parseInt(text.replaceAll('_', ''), 10) + 0 : undefined
  }
  return undefined
}

/** pydantic's lax bool, or undefined when it would refuse the value. */
const laxBool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : undefined
  }
  if (typeof value === 'string') {
    const text = value.toLowerCase()
    return TRUE_TEXT.has(text) ? true : FALSE_TEXT.has(text) ? false : undefined
  }
  return undefined
}

/** A zod type that reads a value with `read`, failing with `message` where it answers undefined. */
const lax = <T>({ read, message }: { read: (value: unknown) => T | undefined; message: string }) =>
  z.unknown().transform((value, ctx): T => {
    const parsed = read(value)
    if (parsed === undefined) {
      ctx.addIssue({ code: 'custom', message })
      return z.NEVER
    }
    return parsed
  })

/** pydantic `int`: integers, integral floats, integer strings and bools. */
export const pyInt = lax({ read: laxInt, message: 'Input should be a valid integer' })

/** pydantic `bool`: true/false, 0/1, and the strings pydantic accepts. */
export const pyBool = lax({ read: laxBool, message: 'Input should be a valid boolean' })

/** pydantic `str`: a string and nothing else, not even a number. */
export const pyStr = z.string({ error: 'Input should be a valid string' })

/** `X | None = None`: may be left out or sent as null, and reads as null either way. */
const orNone = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? null)

/**
 * A FastAPI scalar query parameter. Fastify hands a repeated parameter over
 * as an array, where Starlette answered with the last value given.
 */
const lastOf = (value: unknown): unknown => (Array.isArray(value) ? value.at(-1) : value)

export const EmailQuery = z.object({ email: z.preprocess(lastOf, pyStr) })

export const OptionalEmailQuery = z.object({ email: z.preprocess(lastOf, pyStr.optional()) })

export const NotesBody = z.object({ email: pyStr, notes: pyStr })

export const ResetExpiryBody = z.object({
  email: pyStr,
  days: orNone(pyInt),
  expires_at: orNone(pyStr),
})

export const ResetTierBody = z.object({ email: pyStr, tier: pyStr })

export const ReissueInviteBody = z.object({ email: pyStr, tier: pyStr })

export const EmailBody = z.object({ email: pyStr })

export const SetTagBody = z.object({ email: pyStr, tag: orNone(pyStr) })

export const SetDownloadsBody = z.object({ email: pyStr, allow: pyBool })

export const LinkAddressBody = z.object({ stripe_email: pyStr, plex_email: orNone(pyStr) })
