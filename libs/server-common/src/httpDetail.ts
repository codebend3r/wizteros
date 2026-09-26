import { STATUS_CODES } from 'node:http'
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import type { HttpAdapterHost } from '@nestjs/core'

// FastAPI answers every error as {"detail": ...}, and the portal shows that
// text to the admin, so the servers keep the shape. A route that fails on
// purpose throws `httpError`, which carries its own detail; anything else,
// Nest's own 404 for an unknown route included, is answered with the status
// phrase, which is what Starlette sends when an HTTPException has no detail.

/** An HTTP error whose body is exactly `{ detail }`. */
export const httpError = ({ status, detail }: { status: number; detail: unknown }): HttpException =>
  new HttpException({ detail }, status)

const hasDetail = (body: unknown): body is { detail: unknown } =>
  typeof body === 'object' && body !== null && 'detail' in body

const phrase = (status: number): string => STATUS_CODES[status] ?? 'Error'

/** The body FastAPI would have sent for this failure. */
export const detailBody = (exception: unknown): { detail: unknown } => {
  if (!(exception instanceof HttpException)) {
    return { detail: phrase(500) }
  }
  const body: unknown = exception.getResponse()
  return hasDetail(body) ? body : { detail: phrase(exception.getStatus()) }
}

@Catch()
export class HttpDetailFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpDetailFilter')

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const status = exception instanceof HttpException ? exception.getStatus() : 500
    if (!(exception instanceof HttpException)) {
      this.log.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : exception,
      )
    }
    this.adapterHost.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      detailBody(exception),
      status,
    )
  }
}
