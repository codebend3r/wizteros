import type { z } from 'zod'

/** A schema's output made deeply read-only, the shape every reader of a
    response gets: nothing on either side of the wire edits a body it was
    handed, and the portal's types said so before they were schemas. */
export type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: Immutable<T[Key]> }
    : T

/** What a schema vouches for once a value has passed it. */
export type Wire<Schema extends z.ZodType> = Immutable<z.output<Schema>>

/**
 * A schema as a type guard.
 *
 * The value that passed is handed back as it arrived rather than as zod's
 * parsed copy, so a reader sees exactly the bytes the server sent, extra
 * fields included; the schema only vouches for the ones it names.
 */
export const guardOf =
  <Schema extends z.ZodType>(schema: Schema) =>
  (value: unknown): value is Wire<Schema> =>
    schema.safeParse(value).success
