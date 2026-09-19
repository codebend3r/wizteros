import { formatCount } from '@/pages/Plays/playsFormat'
import styles from '@/pages/Plays/BreakdownList.module.scss'

export type BreakdownRow = {
  readonly key: string
  readonly name: string
  readonly value: number
  /** The class binding this row to its colour (a server's series slot).
      Absent, the meter wears the accent: a type or a quality is a share of
      one measure, not an identity, so one hue serves the whole list. */
  readonly className?: string
}

type BreakdownListProps = {
  readonly title: string
  /** What the shares are of, and what is left out ("Video plays only"). */
  readonly note?: string
  readonly rows: readonly BreakdownRow[]
  /** The noun a zero total names: "No plays". */
  readonly unit: string
}

/** How far along its track the bar is drawn. Clamped, so a share outside the
    scale stays inside the track instead of overflowing it. */
const barWidth = (share: number): string => `${Math.max(0, Math.min(share * 100, 100))}%`

/** A few named shares of one total, each stated as a count and a percentage
    with a meter restating it. The meter is a second reading of a fact the
    figures already carry, so it is hidden from the accessibility tree
    rather than repeating the number there. */
export const BreakdownList = ({ title, note, rows, unit }: BreakdownListProps) => {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  return (
    <section className={styles.breakdown} aria-label={title}>
      <h3 className={styles.title}>{title}</h3>
      {note !== undefined && <p className={styles.note}>{note}</p>}
      {total === 0 ? (
        <p className={styles.note}>No {unit} in this window.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const share = row.value / total
            return (
              <li
                key={row.key}
                className={
                  row.className === undefined ? styles.row : `${styles.row} ${row.className}`
                }
              >
                <span className={styles.name}>{row.name}</span>
                <span className={styles.figure}>
                  {formatCount(row.value)}
                  <span className={styles.share}>{` ${Math.round(share * 100)}%`}</span>
                </span>
                <span className={styles.meter} aria-hidden="true">
                  <span className={styles.fill} style={{ width: barWidth(share) }} />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
