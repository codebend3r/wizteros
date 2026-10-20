/**
 * Runtime type guards shared by every module that validates a response or a
 * persisted blob before trusting its shape.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
