// What Starlette's CORSMiddleware sent the portal's browsers, so a browser
// talking to a NestJS server sees the same preflight answers it always has.

// The request headers Starlette always allows on top of the configured ones.
const SAFELISTED_HEADERS: readonly string[] = [
  'Accept',
  'Accept-Language',
  'Content-Language',
  'Content-Type',
]

// Starlette's default max_age: a browser reuses a preflight answer for ten
// minutes instead of asking again before nearly every request.
const PREFLIGHT_MAX_AGE_SECONDS = 600

export type CorsOptions = {
  origin: string | string[]
  methods: string[]
  allowedHeaders: string[]
  maxAge: number
  optionsSuccessStatus: number
}

/** `enableCors` options that answer exactly as Starlette's CORSMiddleware did. */
export const starletteCors = ({
  origin,
  methods,
  headers,
}: {
  origin: string | string[]
  methods: string[]
  headers: readonly string[]
}): CorsOptions => ({
  origin,
  methods,
  // Starlette merges the configured headers into the safelisted set and sorts
  // the result.
  allowedHeaders: [...new Set([...SAFELISTED_HEADERS, ...headers])].toSorted(),
  maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  // Starlette answered a preflight with 200; @fastify/cors defaults to 204.
  optionsSuccessStatus: 200,
})
