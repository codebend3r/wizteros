// Reading a route's answer the way the portal does.
//
// The route tests read every 200 through the libs/wire schema the portal
// parses that response with: a body that fails one is a page the portal
// refuses to draw. Reading through it both checks the contract and hands each
// test a typed body without a cast.

import { guardOf, type Wire } from '@wizteros/wire'
import type { z } from 'zod'

/** What `inject` answers with, as far as reading a body goes. */
export type Answer = Readonly<{ statusCode: number; body: string }>

/**
 * A 200's body, vouched for by the schema the portal reads it with. Anything
 * else fails the test with the body in the message, which is the fastest
 * route to what came back wrong.
 */
export const bodyOf = <Schema extends z.ZodType>({
  answer,
  schema,
}: {
  answer: Answer
  schema: Schema
}): Wire<Schema> => {
  if (answer.statusCode !== 200) {
    throw new Error(`expected a 200 and got ${answer.statusCode}: ${answer.body}`)
  }
  const value: unknown = JSON.parse(answer.body)
  if (!guardOf(schema)(value)) {
    throw new Error(`the portal would refuse this body: ${answer.body}`)
  }
  return value
}
