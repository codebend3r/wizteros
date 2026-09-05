import { useId, type ChangeEvent } from 'react'
import { IconTile } from '@/components/IconTile/IconTile'
import styles from '@/pages/Fleet/UpdateRateSlider.module.scss'
import { DEFAULT_UPDATE_INTERVAL_MS, UPDATE_INTERVAL_STOPS_MS } from '@/stores/fleetPrefsStore'

type UpdateRateSliderProps = {
  readonly intervalMs: number
  readonly onChange: (intervalMs: number) => void
}

const formatInterval = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`)

/** A discrete slider over the polling stops.

    A native range input, so focus, arrow keys, and the thumb all come from
    the browser; the slider's numeric scale is the stop index, with the human
    reading supplied through `aria-valuetext` and the visible readout. */
export const UpdateRateSlider = ({ intervalMs, onChange }: UpdateRateSliderProps) => {
  const id = useId()
  const index = UPDATE_INTERVAL_STOPS_MS.findIndex((stop) => stop === intervalMs)
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(UPDATE_INTERVAL_STOPS_MS[Number(event.target.value)] ?? DEFAULT_UPDATE_INTERVAL_MS)
  }

  return (
    <div className={styles.control}>
      {/* ahead of the label, never part of it: the slider's accessible name
        stays the two words a reader can find it by */}
      <IconTile name="refresh" tone="muted" />
      <label className={styles.label} htmlFor={id}>
        Update every
      </label>
      <input
        className={styles.slider}
        id={id}
        type="range"
        min={0}
        max={UPDATE_INTERVAL_STOPS_MS.length - 1}
        step={1}
        value={index === -1 ? UPDATE_INTERVAL_STOPS_MS.indexOf(DEFAULT_UPDATE_INTERVAL_MS) : index}
        aria-valuetext={formatInterval(intervalMs)}
        onChange={handleChange}
      />
      <span className={styles.readout}>{formatInterval(intervalMs)}</span>
    </div>
  )
}
