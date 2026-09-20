import type { ReactNode } from 'react'
import styles from '@/pages/Plays/Pager.module.scss'
import tableStyles from '@/pages/Plays/DataTable.module.scss'

type PagerProps = {
  /** The current page, 1-based, the way the monitor numbers them. */
  readonly page: number
  readonly pageCount: number
  readonly onPageChange: (page: number) => void
  /** What is being paged, in words: "1,050 titles". */
  readonly summary?: string
}

/** Previous, position, next, and the size of what they walk. Both buttons are
    real buttons, disabled at the ends, so the keyboard reaches them and the
    end of the list is stated rather than found by a click that does nothing. */
export const Pager = ({ page, pageCount, onPageChange, summary }: PagerProps) => (
  <nav className={styles.pager} aria-label="Pages">
    <button
      className={styles.button}
      type="button"
      onClick={() => onPageChange(page - 1)}
      disabled={page <= 1}
    >
      Prev
    </button>
    <span className={styles.count}>
      Page {page} of {Math.max(1, pageCount)}
    </span>
    <button
      className={styles.button}
      type="button"
      onClick={() => onPageChange(page + 1)}
      disabled={page >= pageCount}
    >
      Next
    </button>
    {summary !== undefined && <span className={styles.summary}>{summary}</span>}
  </nav>
)

type PagedTableProps = {
  readonly page: number
  readonly pageCount: number
  readonly onPageChange: (page: number) => void
  /** What is being paged, in words, shown on the pager above the table only:
      the same sentence twice is the page repeating itself. */
  readonly summary?: string
  /** The table itself. It scrolls inside its own box, so a wide row never
      widens the page. */
  readonly children: ReactNode
}

/** A table between two pagers.
 *
 * One above and one below because a long page leaves the top pager off screen
 * by the time the reader has finished reading, and scrolling back up to turn
 * the page is the thing this saves.
 */
export const PagedTable = ({
  page,
  pageCount,
  onPageChange,
  summary,
  children,
}: PagedTableProps) => (
  <>
    <Pager page={page} pageCount={pageCount} onPageChange={onPageChange} summary={summary} />
    <div className={tableStyles.scroller}>{children}</div>
    <Pager page={page} pageCount={pageCount} onPageChange={onPageChange} />
  </>
)
