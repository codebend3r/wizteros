import { NestFactory } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { starletteCors } from '@wizteros/server-common'
import { AppModule } from '@/appModule.js'
import { adminAllowedOrigins } from '@/config.js'

/**
 * The configured application, not yet listening, so a test can drive it
 * through `inject` exactly as `main.ts` serves it.
 */
export const createApp = async ({
  quiet = false,
}: { quiet?: boolean } = {}): Promise<NestFastifyApplication> => {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: quiet ? false : undefined,
    // Stripe signs the exact bytes it sent. Keeping them on the request is
    // what lets the webhook verify a signature that JSON parsing would break.
    rawBody: true,
  })

  // Only the configured portal origins may call the admin routes from a
  // browser, and only with the two headers the portal sends.
  app.enableCors(
    starletteCors({
      origin: adminAllowedOrigins(),
      methods: ['GET', 'POST'],
      headers: ['Authorization', 'Content-Type'],
    }),
  )
  app.enableShutdownHooks()
  return app
}
