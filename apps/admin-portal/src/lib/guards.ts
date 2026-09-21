/**
 * Runtime type guards shared by every module that validates a response or a
 * persisted blob before trusting its shape.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === 'number'

export const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

export const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export const isNumberMap = (value: unknown): value is Readonly<Record<string, number>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'number')
