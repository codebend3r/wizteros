import { CPU_RANGES } from '@/stores/fleetPrefsStore'
import styles from '@/pages/Fleet/RangePicker.module.scss'

type RangePickerProps = {
  readonly minutes: number
  readonly onChange: (minutes: number) => void
}

/** How far back the chart looks, as one pressed button among several.

    Buttons rather than a slider: the stops are named spans a reader picks by
    name, not a continuum, and `aria-pressed` is what says which one is on -
    the chosen button is never marked by colour alone.
*/
export const RangePicker = ({ minutes, onChange }: RangePickerProps) => (
  <div className={styles.picker} role="group" aria-label="CPU history range">
    {CPU_RANGES.map((range) => (
      <button
        key={range.minutes}
        className={styles.range}
        type="button"
        aria-pressed={range.minutes === minutes}
        onClick={() => onChange(range.minutes)}
      >
        {range.label}
      </button>
    ))}
  </div>
)
