import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import styles from '@/components/AsyncSection/AsyncSection.module.scss'

const FALLBACK_ERROR = 'Could not reach the fleet monitor.'

/** What actually went wrong, not a guess: the API modules compose precise
    messages (an unset base, a schema the monitor answered with), and
    collapsing them into one sentence loses the only diagnostic the page has.
    `fallback` is what a thrown non-Error reads as, which each page words for
    the sentence it sits in. */
export const errorMessage = ({
  error,
  fallback = FALLBACK_ERROR,
}: {
  error: unknown
  fallback?: string
}): string => (error instanceof Error && error.message.length > 0 ? error.message : fallback)

type SectionProps = {
  readonly id: string
  readonly title: string
  /** One sentence under the heading saying what the section counts. */
  readonly lede?: string
  readonly children: ReactNode
}

/** A titled region of an admin page, headed and named for assistive tech.
 *
 * Every page here is a stack of these, so the heading, its rule and the gap
 * under it are decided once: a second copy of the markup is how two sections
 * a page apart end up a few pixels different.
 */
export const Section = ({ id, title, lede, children }: SectionProps) => (
  <section className={styles.section} aria-labelledby={id}>
    <h2 className={styles.title} id={id}>
      {title}
    </h2>
    {lede !== undefined && <p className={styles.lede}>{lede}</p>}
    {children}
  </section>
)

type AsyncSectionProps<T> = {
  readonly id: string
  readonly title: string
  readonly lede?: string
  readonly query: UseQueryResult<T>
  /** What the section says while the query is in flight. Omitted by a section
      whose own body holds the loading state: a placeholder shaped like the
      thing being loaded, with a line of text under it, is the same news
      twice. */
  readonly loadingLabel?: string
  readonly errorSuffix: string
  /** Rendered under the lede in every query state: a control that tunes the
      query must stay reachable while that query is loading or failing. */
  readonly controls?: ReactNode
  readonly children: (data: T) => ReactNode
}

/** A section that says which of loading, failed, or loaded it is showing.
 *
 * Every view that reads the monitor needs all three states, and a section that
 * silently renders nothing while a query is in flight reads as a ledger with
 * nothing in it. The loaded body still renders while a refetch is in flight,
 * so a page change or a filter press repaints from the last answer rather than
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
  <Section id={id} title={title} lede={lede}>
    {controls}
    {!!query.isPending && loadingLabel !== undefined && (
      <p className={styles.muted} aria-live="polite">
        {loadingLabel}
      </p>
    )}
    {!!query.isError && (
      <p className={styles.alert} role="alert">
        {`${errorMessage({ error: query.error })} ${errorSuffix}`}
      </p>
    )}
    {!!query.data && children(query.data)}
  </Section>
)
