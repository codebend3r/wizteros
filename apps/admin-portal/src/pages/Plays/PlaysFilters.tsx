import { IconTile } from '@/components/IconTile/IconTile'
import type { IconName } from '@/components/Icon/Icon'
import {
  PLAY_KINDS,
  PLAY_QUALITIES,
  PLAY_RANGES,
  type KindFilter,
  type PlaysFilters as Filters,
  type QualityFilter,
} from '@/lib/playsApi'
import styles from '@/pages/Plays/PlaysFilters.module.scss'

/** One server the select can name: the config host and, when the monitor has
    heard the server's own name, that name beside it. */
export type FilterHost = {
  readonly host: string
  readonly label: string
}

type PlaysFiltersProps = {
  readonly filters: Filters
  readonly hosts: readonly FilterHost[]
  readonly onRange: (days: number) => void
  readonly onKind: (kind: KindFilter) => void
  readonly onQuality: (quality: QualityFilter) => void
  readonly onHost: (host: string) => void
}

type SegmentProps<T extends string | number> = {
  readonly label: string
  readonly icon: IconName
  readonly options: readonly { readonly value: T; readonly label: string }[]
  readonly selected: T
  readonly onChange: (value: T) => void
}

/** One choice among a few named ones, as pressed buttons.
 *
 * Buttons rather than a select: the stops are a handful of words a reader
 * picks by name, and `aria-pressed` is what says which one is on. The chosen
 * button is never marked by colour alone. The tile ahead names the group at a
 * glance; the group's own label does so for a reader.
 */
const Segment = <T extends string | number>({
  label,
  icon,
  options,
  selected,
  onChange,
}: SegmentProps<T>) => (
  <div className={styles.group} role="group" aria-label={label}>
    <IconTile name={icon} tone="muted" />
    {options.map((option) => (
      <button
        key={option.value}
        className={styles.option}
        type="button"
        aria-pressed={option.value === selected}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
)

const RANGE_OPTIONS = PLAY_RANGES.map((range) => ({ value: range.days, label: range.label }))
const KIND_OPTIONS = PLAY_KINDS.map((kind) => ({ value: kind.kind, label: kind.label }))
const QUALITY_OPTIONS = PLAY_QUALITIES.map((quality) => ({
  value: quality.quality,
  label: quality.label,
}))

/** The four filters every view shares, in one toolbar above all of them.
 *
 * Outside the sections on purpose, so a failing query never takes down the
 * controls that could fix it, and above the tabs because they apply to every
 * tab alike: switching views never resets what is being asked about.
 */
export const PlaysFilters = ({
  filters,
  hosts,
  onRange,
  onKind,
  onQuality,
  onHost,
}: PlaysFiltersProps) => {
  // A persisted host the monitor no longer lists still needs an option, or
  // the select would show "All servers" while the reads keep filtering.
  const known = hosts.some((candidate) => candidate.host === filters.host)
  const options =
    filters.host.length > 0 && !known
      ? [...hosts, { host: filters.host, label: filters.host }]
      : hosts
  return (
    <div className={styles.toolbar} role="group" aria-label="Play history filters, all views">
      <Segment
        label="Range"
        icon="history"
        options={RANGE_OPTIONS}
        selected={filters.days}
        onChange={onRange}
      />
      <Segment
        label="Type"
        icon="play"
        options={KIND_OPTIONS}
        selected={filters.kind}
        onChange={onKind}
      />
      <Segment
        label="Quality"
        icon="gauge"
        options={QUALITY_OPTIONS}
        selected={filters.quality}
        onChange={onQuality}
      />
      <label className={styles.serverField}>
        <IconTile name="box" tone="muted" />
        <span className={styles.serverLabel}>Server</span>
        <select
          className={styles.server}
          value={filters.host}
          onChange={(event) => onHost(event.target.value)}
        >
          <option value="">All servers</option>
          {options.map((option) => (
            <option key={option.host} value={option.host}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
