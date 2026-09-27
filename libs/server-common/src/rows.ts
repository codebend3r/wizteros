// better-sqlite3 hands rows back as `unknown`, and the house rules forbid a
// cast, so every read narrows here. A column holding the wrong type is a
// schema bug rather than bad input, so it throws instead of guessing.

export type Row = Readonly<Record<string, unknown>>

export const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The rows of an `.all()` result, each narrowed. */
export const asRows = (values: readonly unknown[]): Row[] => values.filter(isRow)

/** The row of a `.get()` result, or null when the query matched nothing. */
export const asRow = (value: unknown): Row | null => (isRow(value) ? value : null)

const mismatch = ({
  column,
  expected,
  value,
}: {
  column: string
  expected: string
  value: unknown
}) => new TypeError(`column ${column}: expected ${expected}, got ${typeof value}`)

/** Typed reads of one row's columns, the equivalent of `row["name"]` on a sqlite3.Row. */
export const fields = (row: Row) => ({
  text: (column: string): string => {
    const value = row[column]
    if (typeof value !== 'string') {
      throw mismatch({ column, expected: 'text', value })
    }
    return value
  },
  textOrNull: (column: string): string | null => {
    const value = row[column]
    if (value === null || value === undefined) {
      return null
    }
    if (typeof value !== 'string') {
      throw mismatch({ column, expected: 'text or null', value })
    }
    return value
  },
  number: (column: string): number => {
    const value = row[column]
    if (typeof value !== 'number') {
      throw mismatch({ column, expected: 'number', value })
    }
    return value
  },
  numberOrNull: (column: string): number | null => {
    const value = row[column]
    if (value === null || value === undefined) {
      return null
    }
    if (typeof value !== 'number') {
      throw mismatch({ column, expected: 'number or null', value })
    }
    return value
  },
})

/** SQLite has no boolean, and better-sqlite3 refuses to bind one: store 1 or 0. */
export const flag = (value: boolean): 1 | 0 => (value ? 1 : 0)
