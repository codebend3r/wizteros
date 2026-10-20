import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { starletteCors } from './cors.js'
import { HttpDetailFilter } from './httpDetail.js'
import { starletteMethodNotAllowed } from './methodNotAllowed.js'
import { fastApiValidationPipe } from './validation.js'

/**
 * Make an app answer the way the FastAPI one did: Starlette's CORS answers
 * for `cors`, every error as `{"detail": ...}`, FastAPI's 422 for a query or
 * body that fails its schema, and a 405 for a wrong method on a known path.
 *
 * Call it before `app.init()`, since the 405 learns the paths as Nest
 * registers them.
 */
export const fastApiCompat = ({
  app,
  cors,
}: {
  app: NestFastifyApplication
  /** Who may call the app from a browser, and with which methods and headers. */
  cors: Parameters<typeof starletteCors>[0]
}): NestFastifyApplication => {
  app.enableCors(starletteCors(cors))
  app.useGlobalFilters(new HttpDetailFilter({ httpAdapter: app.getHttpAdapter() }))
  app.useGlobalPipes(fastApiValidationPipe())
  starletteMethodNotAllowed(app)
  return app
}
