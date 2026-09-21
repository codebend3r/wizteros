import { swatchClass, type ChartMark } from '@/components/Chart/ChartTooltip'
import styles from '@/components/Chart/chart.module.scss'

export type ChartLegendItem = {
  readonly key: string
  readonly name: string
  /** The class carrying this series' colour, from the page's own palette. */
  readonly swatchClass?: string
  /** What is true of this series and no other, such as a host that reported
      nothing: said in words, because a legend entry that differed only in
      colour would say nothing to a reader who cannot see it. */
  readonly note?: string
}

type ChartLegendProps = {
  readonly items: readonly ChartLegendItem[]
  readonly mark?: ChartMark
}

/** What each mark on the plot stands for, named in words beside its colour. */
export const ChartLegend = ({ items, mark = 'square' }: ChartLegendProps) => (
  <ul className={styles.legend}>
    {items.map((item) => (
      <li key={item.key} className={styles.legendItem}>
        <span className={swatchClass({ mark, tint: item.swatchClass })} aria-hidden="true" />
        <span>{item.name}</span>
        {item.note !== undefined && <span className={styles.legendNote}>{item.note}</span>}
      </li>
    ))}
  </ul>
)
