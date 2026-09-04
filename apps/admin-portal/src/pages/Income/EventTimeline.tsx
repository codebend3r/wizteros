import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMoney, type IncomeEvent, type IncomeKind } from '@/lib/income'
import { TIER_LABELS } from '@/lib/inviteRules'
import styles from '@/pages/Income/EventTimeline.module.scss'

type EventTimelineProps = {
  readonly events: readonly IncomeEvent[]
}

export const KIND_LABELS: Record<IncomeKind, string> = {
  signup: 'Signup',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  cancel: 'Cancellation',
  cancel_scheduled: 'Cancellation scheduled',
  payment_failed: 'Payment failed',
  outage: 'Outage',
}

// The pills double as a legend: every kind the list can hold, with its count.
const FILTERS: ReadonlyArray<{ kind: IncomeKind; label: string }> = [
  { kind: 'signup', label: 'Signups' },
  { kind: 'upgrade', label: 'Upgrades' },
  { kind: 'downgrade', label: 'Downgrades' },
  { kind: 'cancel', label: 'Cancellations' },
  { kind: 'cancel_scheduled', label: 'Scheduled' },
  { kind: 'payment_failed', label: 'Payments failed' },
  { kind: 'outage', label: 'Outages' },
]

// Enough to read a season at a glance; the rest sits behind one button.
const PAGE = 60

const formatDate = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString()
}

/** What happened, in words: the tier a member arrived at, moved to, or left. */
const describe = (event: IncomeEvent): string => {
  switch (event.kind) {
    case 'signup':
      if (event.tier === null) return event.detail
      return event.delta === 0
        ? `${TIER_LABELS[event.tier]} tier, access restored`
        : `${TIER_LABELS[event.tier]} tier`
    case 'upgrade':
    case 'downgrade':
      return event.fromTier !== null && event.tier !== null
        ? `${TIER_LABELS[event.fromTier]} to ${TIER_LABELS[event.tier]}`
        : event.detail
    case 'cancel':
      return event.tier === null ? 'subscription ended' : `${TIER_LABELS[event.tier]} tier ended`
    default:
      return event.detail
  }
}

/** Every movement and incident, newest first, filterable by kind. */
export const EventTimeline = ({ events }: EventTimelineProps) => {
  const [kind, setKind] = useState<IncomeKind | null>(null)
  const [showAll, setShowAll] = useState(false)
  const filtered = kind === null ? events : events.filter((event) => event.kind === kind)
  const visible = showAll ? filtered : filtered.slice(0, PAGE)

  return (
    <div className={styles.timeline}>
      <div className={styles.filters} role="group" aria-label="Filter by kind">
        <button
          className={kind === null ? styles.filterActive : styles.filterPill}
          type="button"
          aria-pressed={kind === null}
          onClick={() => setKind(null)}
        >
          All {events.length}
        </button>
        {FILTERS.map((filter) => (
          <button
            key={filter.kind}
            className={kind === filter.kind ? styles.filterActive : styles.filterPill}
            type="button"
            aria-pressed={kind === filter.kind}
            onClick={() => setKind(kind === filter.kind ? null : filter.kind)}
          >
            {filter.label} {events.filter((event) => event.kind === filter.kind).length}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className={styles.muted}>Nothing recorded yet.</p>
      ) : (
        <ol className={styles.list} aria-label="Income timeline">
          {visible.map((event) => (
            <li key={event.id} className={styles.row} data-kind={event.kind}>
              <time className={styles.when} dateTime={event.at}>
                {formatDate(event.at)}
              </time>
              <span className={styles.kind}>{KIND_LABELS[event.kind]}</span>
              {event.email === null ? (
                <span className={styles.who}>fleet</span>
              ) : (
                <Link className={styles.who} to={`/user?email=${encodeURIComponent(event.email)}`}>
                  {event.email}
                </Link>
              )}
              <span className={styles.what}>{describe(event)}</span>
              {event.delta !== 0 && (
                <span className={styles.delta}>
                  {event.delta > 0 ? '+' : '-'}
                  {formatMoney(Math.abs(event.delta))}/mo
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {filtered.length > visible.length && (
        <button className={styles.more} type="button" onClick={() => setShowAll(true)}>
          Show all {filtered.length}
        </button>
      )}
    </div>
  )
}
