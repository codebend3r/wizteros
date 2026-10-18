/** The stack when present, otherwise the thrown value as text. */
export const stackOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error)
