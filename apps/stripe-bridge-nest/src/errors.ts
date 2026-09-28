/**
 * What an error log line carries under its message: the stack when there is
 * one, else the error as text.
 */
export const stackOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error)
