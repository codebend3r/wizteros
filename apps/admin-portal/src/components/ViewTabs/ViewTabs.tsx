import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon/Icon'
import styles from '@/components/ViewTabs/ViewTabs.module.scss'

// Over the title on a tab, and alone on the action: both are read at 20px,
// where the hairline stroke drawn for 16px goes thin.
const TAB_GLYPH_PX = 20
const TAB_STROKE = 1.75

export type ViewTab<T extends string> = {
  readonly id: T
  readonly title: string
  readonly icon: IconName
}

type ViewTabsProps<T extends string> = {
  readonly tabs: readonly ViewTab<T>[]
  readonly active: T
  readonly onSelect: (id: T) => void
  /** The strip's accessible name. */
  readonly label: string
  /** One control that applies to whichever panel is showing, drawn at the far
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

/** The tab the arrow keys move to, wrapping at both ends, as the ARIA tabs
    pattern specifies: End is one Left from Home. */
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

/** One view at a time, with the ARIA tabs pattern behind it.
 *
 * Only the selected panel is rendered, which is the point rather than a
 * detail: the panel that is mounted is the one whose query runs, so five views
 * cost one request per interval instead of five. A hidden panel kept mounted
 * would keep a timer running for something nobody is looking at.
 *
 * Ids come from `useId`, so two strips on one page cannot mint the same id and
 * point one strip's tab at the other's panel.
 */
export const ViewTabs = <T extends string>({
  tabs,
  active,
  onSelect,
  label,
  action,
  children,
}: ViewTabsProps<T>) => {
  const strip = useRef<HTMLDivElement | null>(null)
  const prefix = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const current = tabs.findIndex((tab) => tab.id === active)
    const target = nextIndex({ key: event.key, current, count: tabs.length })
    if (target === null) return
    const tab = tabs[target]
    if (tab === undefined) return
    event.preventDefault()
    onSelect(tab.id)
    // focus follows selection in this pattern, so the next arrow key steps
    // from where the eye is rather than from where focus was left behind
    strip.current?.querySelectorAll('button')[target]?.focus()
  }

  return (
    <div className={styles.tabs}>
      <div className={styles.header}>
        <div className={styles.strip} role="tablist" aria-label={label} ref={strip}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${prefix}tab-${tab.id}`}
              className={styles.tab}
              aria-selected={tab.id === active}
              aria-controls={`${prefix}panel-${tab.id}`}
              // one stop for the whole strip: Tab reaches the selected tab, and
              // the arrow keys move within it
              tabIndex={tab.id === active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              // on the tab rather than the strip: the strip is not focusable in
              // this pattern, so a handler there would only ever fire by
              // bubbling from here anyway
              onKeyDown={onKeyDown}
            >
              {/* the glyph is hidden, so the tab's name stays the title alone */}
              <Icon name={tab.icon} size={TAB_GLYPH_PX} strokeWidth={TAB_STROKE} />
              <span>{tab.title}</span>
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
            <Icon name={action.icon} size={TAB_GLYPH_PX} strokeWidth={TAB_STROKE} />
          </button>
        )}
      </div>

      <div
        className={styles.panel}
        role="tabpanel"
        id={`${prefix}panel-${active}`}
        aria-labelledby={`${prefix}tab-${active}`}
        // the panel holds focusable content of its own, so it takes a stop
        // only when it would otherwise be unreachable
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  )
}
