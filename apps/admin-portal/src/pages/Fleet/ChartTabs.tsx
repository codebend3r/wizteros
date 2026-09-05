import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon/Icon'
import type { MetricKind } from '@/lib/fleetApi'
import styles from '@/pages/Fleet/ChartTabs.module.scss'
import { METRIC_COPY } from '@/pages/Fleet/metricCopy'

// Over the title on a tab, and alone on the action: both are read at 20px,
// where the hairline stroke drawn for 16px goes thin.
const CONTROL_GLYPH_PX = 20
const CONTROL_STROKE = 1.75

type ChartTabsProps = {
  readonly kinds: readonly MetricKind[]
  readonly active: MetricKind
  readonly onSelect: (kind: MetricKind) => void
  /** One control that applies to whichever chart is showing, drawn at the far
      end of the strip. Outside the tablist on purpose: the arrow keys walk
      tabs, and a button among them would be a stop they skip. Icon-only, so
      the label is its accessible name and its tooltip rather than a caption. */
  readonly action?: {
    readonly label: string
    readonly icon: IconName
    readonly onClick: () => void
  }
  readonly children: ReactNode
}

/** The tab the arrow keys move to, wrapping at both ends.
 *
 * Wrapping is what the ARIA tabs pattern specifies, and it is the behaviour
 * that makes a four-tab strip reachable without looking: End is one Left from
 * Home.
 */
const nextIndex = ({
  key,
  current,
  count,
}: {
  key: string
  current: number
  count: number
}): number | null => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[key]
  if (step !== undefined) return (current + step + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** One chart at a time, with the ARIA tabs pattern behind it.
 *
 * Only the selected panel is rendered, which is the point rather than a
 * detail: the chart that is mounted is the one whose query polls, so four
 * charts cost one request per interval instead of four. A hidden panel kept
 * mounted would keep its own per-second timer running for a chart nobody is
 * looking at.
 */
export const ChartTabs = ({ kinds, active, onSelect, action, children }: ChartTabsProps) => {
  const strip = useRef<HTMLDivElement | null>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const current = kinds.indexOf(active)
    const target = nextIndex({ key: event.key, current, count: kinds.length })
    if (target === null) return
    const kind = kinds[target]
    if (kind === undefined) return
    event.preventDefault()
    onSelect(kind)
    // focus follows selection in this pattern, so the next arrow key steps
    // from where the eye is rather than from where focus was left behind
    strip.current?.querySelectorAll('button')[target]?.focus()
  }

  return (
    <div className={styles.tabs}>
      <div className={styles.header}>
        <div className={styles.strip} role="tablist" aria-label="Fleet charts" ref={strip}>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              id={`chart-tab-${kind}`}
              className={styles.tab}
              aria-selected={kind === active}
              aria-controls={`chart-panel-${kind}`}
              // one stop for the whole strip: Tab reaches the selected tab, and
              // the arrow keys move within it
              tabIndex={kind === active ? 0 : -1}
              onClick={() => onSelect(kind)}
              // on the tab rather than the strip: the strip is not focusable in
              // this pattern, so a handler there would only ever fire by bubbling
              // from here anyway
              onKeyDown={onKeyDown}
            >
              {/* the glyph is hidden, so the tab's name stays the title alone */}
              <Icon
                name={METRIC_COPY[kind].icon}
                size={CONTROL_GLYPH_PX}
                strokeWidth={CONTROL_STROKE}
              />
              <span>{METRIC_COPY[kind].title}</span>
            </button>
          ))}
        </div>

        {!!action && (
          <button
            type="button"
            className={styles.action}
            aria-label={action.label}
            title={action.label}
            onClick={action.onClick}
          >
            <Icon name={action.icon} size={CONTROL_GLYPH_PX} strokeWidth={CONTROL_STROKE} />
          </button>
        )}
      </div>

      <div
        className={styles.panel}
        role="tabpanel"
        id={`chart-panel-${active}`}
        aria-labelledby={`chart-tab-${active}`}
        // the panel holds focusable content of its own, so it takes a stop
        // only when it would otherwise be unreachable
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  )
}
