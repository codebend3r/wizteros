import styles from '@/components/Chart/chart.module.scss'

/** Which mark a series is drawn with, so its key in the tooltip and the legend
    is the shape the reader is looking at on the plot. */
export type ChartMark = 'square' | 'line'

export type ChartKeyRow = {
  readonly key: string
  /** Already formatted: the chart owns its own units, and a tooltip that
      formatted numbers itself would be a second place for a scale to live. */
  readonly value: string
  readonly name: string
  /** The class carrying this series' colour, from the page's own palette.
      Omitted by a row that stands for no series. */
  readonly swatchClass?: string
}

type ChartTooltipProps = {
  readonly title: string
  readonly rows: readonly ChartKeyRow[]
  /** A summing row under the series, set off by an empty swatch column. */
  readonly total?: {
    readonly value: string
    readonly name: string
  }
  readonly mark?: ChartMark
}

/** One series' key: the colour it is drawn in, in the shape it is drawn as. */
export const swatchClass = ({ mark, tint }: { mark: ChartMark; tint?: string }): string =>
  [styles.swatch, mark === 'line' ? styles.swatchLine : '', tint ?? '']
    .filter((part) => part.length > 0)
    .join(' ')

/** Every series' reading at the inspected point on a chart.
 *
 * Written rather than taking Recharts' default so the key stays the same mark
 * the legend and the page's other views use, and so values print through the
 * chart's own formatter instead of raw.
 */
export const ChartTooltip = ({ title, rows, total, mark = 'square' }: ChartTooltipProps) => {
  // A chart whose series carry no mark of their own gets no swatch column at
  // all, rather than one blank indenting every value it holds.
  const keyed = rows.some((row) => row.swatchClass !== undefined)
  const rowClass = keyed ? styles.tooltipRow : `${styles.tooltipRow} ${styles.tooltipRowPlain}`

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{title}</p>
      <ul className={styles.tooltipRows}>
        {rows.map((row) => (
          <li key={row.key} className={rowClass}>
            {!!keyed && (
              <span
                className={
                  row.swatchClass === undefined
                    ? styles.swatchGap
                    : swatchClass({ mark, tint: row.swatchClass })
                }
                aria-hidden="true"
              />
            )}
            <span className={styles.tooltipValue}>{row.value}</span>
            <span className={styles.tooltipName}>{row.name}</span>
          </li>
        ))}
        {!!total && (
          <li className={rowClass}>
            {!!keyed && <span className={styles.swatchGap} aria-hidden="true" />}
            <span className={styles.tooltipValue}>{total.value}</span>
            <span className={styles.tooltipName}>{total.name}</span>
          </li>
        )}
      </ul>
    </div>
  )
}
