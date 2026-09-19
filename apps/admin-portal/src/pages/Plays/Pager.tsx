import styles from '@/pages/Plays/Pager.module.scss'

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
