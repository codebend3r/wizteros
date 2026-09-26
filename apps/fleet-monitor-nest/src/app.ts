import { HttpAdapterHost, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { HttpDetailFilter, starletteCors } from '@wizteros/server-common'
import { useFastApiJson } from '@/api/json.js'
import { fastApiValidationPipe } from '@/api/validation.js'
import { AppModule } from '@/appModule.js'

/**
 * Everything that makes an app answer the way the FastAPI one did: CORS, the
 * `{detail}` error body, FastAPI's 422 for a bad query, and Pydantic's
 * timestamps. `createApp` applies it, and the route tests apply it to an app
 * built over a testing module, so both answer through the same setup.
 */
export const configureApp = (app: NestFastifyApplication): NestFastifyApplication => {
  // The portal is served from a different origin than this API everywhere it
  // runs (the Vite dev server locally, Netlify in production), so without
  // these headers the browser discards every response and the fleet page
  // reads as down while the API is healthy.
  //
  // Any origin is fine because what protects the API is the bearer on each
  // read, not the network it sits on: an open origin list without
  // credentialed requests lets any page ask, and every gated route still
  // answers 401 without a session. Authorization has to be named, since
  // sending it cross-origin triggers a preflight that otherwise ends the
  // request before it is made.
  app.enableCors(starletteCors({ origin: '*', methods: ['GET'], headers: ['Authorization'] }))
  // Every error leaves as {"detail": ...}, the body FastAPI sent and the
  // portal shows.
  app.useGlobalFilters(new HttpDetailFilter(app.get(HttpAdapterHost)))
  // A bad query parameter is FastAPI's 422, and every Date in a body is
  // written the way Pydantic wrote it.
  app.useGlobalPipes(fastApiValidationPipe())
  useFastApiJson(app)
  return app
}

/**
 * The configured application, not yet listening, so a test can drive it
 * through `inject` exactly as `main.ts` serves it.
 */
export const createApp = async ({
  quiet = false,
}: { quiet?: boolean } = {}): Promise<NestFastifyApplication> => {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: quiet ? false : undefined,
  })
  configureApp(app)
  // The process's signals, not the app's answers, so it stays out of what the
  // route tests share: a test app has no process of its own to stop.
  app.enableShutdownHooks()
  return app
}
