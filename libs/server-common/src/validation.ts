import { StandardSchemaValidationPipe } from '@nestjs/common'
import { httpError } from './httpDetail.js'

// Validation the way FastAPI did it: a query parameter or a request body that
// fails its schema is a 422 with a `detail` list, not Nest's 400. The list's
// entries only have to be readable; the portal shows the text and never
// parses it.

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
