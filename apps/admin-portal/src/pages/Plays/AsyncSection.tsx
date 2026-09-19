import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import styles from '@/pages/Plays/AsyncSection.module.scss'

const FALLBACK_ERROR = 'Could not reach the fleet monitor.'

/** What actually went wrong, not a guess: the API module composes precise
    messages (an unset base, a schema the monitor answered with), and
    collapsing them into one sentence loses the only diagnostic the page has. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_ERROR

type AsyncSectionProps<T> = {
  readonly id: string
  readonly title: string
  /** One sentence under the heading saying what the section counts. */
  readonly lede?: string
  readonly query: UseQueryResult<T>
  /** What the section says while the query is in flight. */
  readonly loadingLabel: string
  readonly errorSuffix: string
  /** Rendered under the lede in every query state: a control that tunes the
      query must stay reachable while that query is loading or failing. */
  readonly controls?: ReactNode
  readonly children: (data: T) => ReactNode
}

/** A section that says which of loading, failed, or loaded it is showing.
 *
 * Every view on the page needs all three states, and a section that silently
 * renders nothing while a query is in flight reads as a ledger with nothing
 * in it. The loaded body still renders while a refetch is in flight, so a
 * page change or a filter press repaints from the last answer rather than
 * emptying the table first.
 */
export const AsyncSection = <T,>({
  id,
  title,
  lede,
  query,
  loadingLabel,
  errorSuffix,
  controls,
  children,
}: AsyncSectionProps<T>) => (
  <section className={styles.section} aria-labelledby={id}>
    <h2 className={styles.title} id={id}>
      {title}
    </h2>
    {lede !== undefined && <p className={styles.lede}>{lede}</p>}
    {controls}
    {!!query.isPending && (
      <p className={styles.muted} aria-live="polite">
        {loadingLabel}
      </p>
    )}
    {!!query.isError && (
      <p className={styles.alert} role="alert">
        {`${errorMessage(query.error)} ${errorSuffix}`}
      </p>
    )}
    {!!query.data && children(query.data)}
  </section>
)
