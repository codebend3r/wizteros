import { classNames } from '@/components/Chart/classNames'
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

/** Which series the reader left off the plot, and how to flip one. A chart
    takes this whole or not at all, so a hidden series always comes with the
    checkbox that brings it back. */
export type SeriesToggle = {
  /** Keys of the series currently left off the plot. */
  readonly hidden: readonly string[]
  readonly onToggle: (key: string) => void
}

/** Lets the reader choose which series are drawn. Without it the legend is a
    plain key. */
export type ChartLegendToggle = SeriesToggle & {
  /** Names the group of checkboxes for a screen reader, such as "Hosts shown
      on the CPU chart". */
  readonly label: string
}

type ChartLegendProps = {
  readonly items: readonly ChartLegendItem[]
  readonly mark?: ChartMark
  readonly toggle?: ChartLegendToggle
}

/** The swatch, name and note one entry shows, shared by both forms. */
const EntryBody = ({
  item,
  mark,
}: {
  readonly item: ChartLegendItem
  readonly mark: ChartMark
}) => (
  <>
    <span className={swatchClass({ mark, tint: item.swatchClass })} aria-hidden="true" />
    <span>{item.name}</span>
    {item.note !== undefined && <span className={styles.legendNote}>{item.note}</span>}
  </>
)

/** What each mark on the plot stands for, named in words beside its colour.
 *
 * Given a toggle, every entry is also a checkbox that shows or hides its
 * series. A native checkbox inside its label, so the whole entry is the click
 * target, the space bar works, and the checked state is announced without any
 * ARIA of our own. The box is tinted the series colour, and an unchecked entry
 * also dims and strikes its name, so hidden is never told by colour alone.
 */
export const ChartLegend = ({ items, mark = 'square', toggle }: ChartLegendProps) => (
  <ul
    className={classNames([styles.legend, !!toggle && styles.legendToggles])}
    aria-label={toggle?.label}
  >
    {items.map((item) => {
      const hidden = toggle?.hidden.includes(item.key) ?? false
      return (
        <li key={item.key} className={styles.legendItem}>
          {toggle ? (
            <label
              className={classNames([styles.legendToggle, item.swatchClass])}
              data-hidden={hidden}
            >
              <input
                type="checkbox"
                className={styles.legendCheck}
                checked={!hidden}
                onChange={() => toggle.onToggle(item.key)}
              />
              <EntryBody item={item} mark={mark} />
            </label>
          ) : (
            <EntryBody item={item} mark={mark} />
          )}
        </li>
      )
    })}
  </ul>
)
