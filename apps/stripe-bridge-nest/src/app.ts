import { HttpAdapterHost, NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import {
  fastApiValidationPipe,
  HttpDetailFilter,
  requireEnv,
  starletteCors,
} from '@wizteros/server-common'
import { AppModule } from '@/appModule.js'
import { adminAllowedOrigins, REQUIRED_ENV } from '@/config.js'

/**
 * Everything that makes an app answer the way the FastAPI one did: CORS, the
 * `{detail}` error body, and FastAPI's 422 for a bad query or body.
 * `createApp` applies it, and the route tests apply it to an app built over a
 * testing module, so both answer through the same setup.
 */
export const configureApp = (app: NestFastifyApplication): NestFastifyApplication => {
  // Only the configured portal origins may call the admin routes from a
  // browser, and only with the two headers the portal sends.
  app.enableCors(
    starletteCors({
      origin: adminAllowedOrigins(),
      methods: ['GET', 'POST'],
      headers: ['Authorization', 'Content-Type'],
    }),
  )
  app.useGlobalFilters(new HttpDetailFilter(app.get(HttpAdapterHost)))
  app.useGlobalPipes(fastApiValidationPipe())
  return app
}

/**
 * The configured application, not yet listening, so a test can drive it
 * through `inject` exactly as `main.ts` serves it.
 *
 * Refuses to build without the environment the bridge cannot act without, so
 * a misconfigured container dies on boot rather than accepting webhooks.
 */
export const createApp = async ({
  quiet = false,
}: { quiet?: boolean } = {}): Promise<NestFastifyApplication> => {
  requireEnv({ names: REQUIRED_ENV })
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: quiet ? false : undefined,
    // Stripe signs the exact bytes it sent. Keeping them on the request is
    // what lets the webhook verify a signature that JSON parsing would break.
    rawBody: true,
  })
  configureApp(app)
  // The process's signals, not the app's answers, so it stays out of what the
  // route tests share: a test app has no process of its own to stop.
  app.enableShutdownHooks()
  return app
}
