import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { pydanticTimestamp } from '@/time.js'

// Every response body leaves through here, so a Date anywhere in a view is
// written the way FastAPI wrote it. JSON.stringify calls a Date's toJSON
// before a replacer sees the value, so the replacer reads the original off
// `this` (the object holding the key) instead of the value it is handed.

function pydanticReplacer(this: unknown, key: string, value: unknown): unknown {
  const original: unknown =
    typeof this === 'object' && this !== null && key in this ? Reflect.get(this, key) : value
  return original instanceof Date ? pydanticTimestamp(original) : value
}

/** A response body as FastAPI would have serialized it. */
export const toJson = (payload: unknown): string => JSON.stringify(payload, pydanticReplacer)

/** Make every reply, errors included, serialize through `toJson`. */
export const useFastApiJson = (app: NestFastifyApplication): void => {
  app.getHttpAdapter().getInstance().setReplySerializer(toJson)
}
