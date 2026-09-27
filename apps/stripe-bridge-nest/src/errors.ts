/**
 * What an error log line carries under its message: the stack when there is
 * one, else the error as text, which is where Python's `log.exception` put
 * the traceback.
 */
export const stackOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error)
