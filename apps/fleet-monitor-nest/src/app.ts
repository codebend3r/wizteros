import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { starletteCors } from '@wizteros/server-common'
import { AppModule } from '@/appModule.js'

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
  app.enableShutdownHooks()
  return app
}
