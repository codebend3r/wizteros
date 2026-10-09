import type { NestFastifyApplication } from '@nestjs/platform-fastify'

// Starlette answers a request whose path matches a route but whose method does
// not with 405 and an Allow header naming the route's methods. Fastify has no
// such answer: the wrong method falls through to the not-found handler, so a
// GET on the POST-only webhook was a 404 where FastAPI sent 405.

type KnownPath = Readonly<{ matches: RegExp; methods: readonly string[] }>

const escapeRegex = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** A route URL as a regex over concrete paths, a `:param` segment matching any one segment. */
const pathPattern = (url: string): RegExp =>
  new RegExp(
    `^${url
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)))
      .join('/')}$`,
  )

/** The methods Starlette lists in Allow: HEAD rides along with GET, sorted. */
const allowHeader = (methods: readonly string[]): string =>
  [...new Set(methods.includes('GET') ? [...methods, 'HEAD'] : methods)].toSorted().join(', ')

/**
 * Answer a wrong method on a known path with 405, as Starlette's router did.
 *
 * Call it before `app.init()`: it learns the paths from Fastify's `onRoute`
 * hook as Nest registers them. Wildcard routes (the CORS preflight's `*`) are
 * left out, or every unknown path would read as a known one.
 */
export const starletteMethodNotAllowed = (app: NestFastifyApplication): NestFastifyApplication => {
  const fastify = app.getHttpAdapter().getInstance()
  const known = new Map<string, KnownPath>()

  fastify.addHook('onRoute', (route) => {
    if (route.url.includes('*')) return
    const methods = [route.method].flat()
    known.set(route.url, {
      matches: known.get(route.url)?.matches ?? pathPattern(route.url),
      methods: [...(known.get(route.url)?.methods ?? []), ...methods],
    })
  })

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.is404) return
    const path = request.url.split('?')[0] ?? request.url
    const methods = [...known.values()]
      .filter(({ matches }) => matches.test(path))
      .flatMap((entry) => entry.methods)
    if (methods.length === 0) return
    return reply
      .code(405)
      .header('allow', allowHeader(methods))
      .send({ detail: 'Method Not Allowed' })
  })

  return app
}
