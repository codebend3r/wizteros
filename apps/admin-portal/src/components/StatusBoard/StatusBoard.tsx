import type { Tier } from '@/site.config'
import { monthlyAmount, monthlyPrice, type BillingCadence } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'
import styles from '@/components/StatusBoard/StatusBoard.module.scss'

// The weights are static placeholders until the bridge exposes real telemetry;
// swap the numbers in one place when it does. The framing stays on
// infrastructure (hardware, storage, uptime), never on content.
const LEDGER_SPLIT = [
  { label: 'Server hardware', weight: 26, tone: 'accent' },
  { label: 'Storage & bandwidth', weight: 23, tone: 'bronze' },
  { label: 'Maintenance & uptime', weight: 12, tone: 'silver' },
  { label: 'Disk replacement reserve', weight: 9, tone: 'dim' },
] as const

const TOTAL_WEIGHT = LEDGER_SPLIT.reduce((sum, { weight }) => sum + weight, 0)

// Split the tier price across the weights in dimes; the largest row absorbs
// the rounding residual so the rows always sum to the price exactly. Annual
// feeds in the monthly-equivalent, so this stays a per-month breakdown in
// either cadence.
const ledgerRows = ({ tier, cadence }: { tier: Tier; cadence: BillingCadence }) => {
  const priceDimes = monthlyAmount({ tier, cadence }) * 10
  const rounded = LEDGER_SPLIT.map(({ label, tone, weight }) => ({
    label,
    tone,
    dimes: Math.round((priceDimes * weight) / TOTAL_WEIGHT),
  }))
  const residual = priceDimes - rounded.reduce((sum, { dimes }) => sum + dimes, 0)
  return rounded.map(({ label, tone, dimes }, index) => ({
    label,
    tone,
    amount: `$${((dimes + (index === 0 ? residual : 0)) / 10).toFixed(2)}`,
  }))
}

const STATUS_ROWS = [
  { label: 'Streaming', value: 'Nominal', live: true },
  { label: '4K transcode headroom', value: 'Nominal', live: true },
  { label: 'Request queue', value: '48h turnaround', live: false },
] as const

const UPTIME = {
  percent: '99.94%',
  caption: 'one 40-minute maintenance window',
  // One cell per five-day slice of the 90-day window; slice 6 is the window
  // the maintenance fell into.
  cells: Array.from({ length: 18 }, (_, index) => ({
    slice: `slice-${index}`,
    state: index === 6 ? 'maintenance' : 'ok',
  })),
} as const

const TONE_CLASS: Record<(typeof LEDGER_SPLIT)[number]['tone'], string> = {
  accent: styles.toneAccent,
  bronze: styles.toneBronze,
  silver: styles.toneSilver,
  dim: styles.toneDim,
}

const LedgerCard = ({ tiers }: { tiers: ReadonlyArray<Tier> }) => {
  const selectedTierId = useTierStore((state) => state.selectedTierId)
  const cadence = useBillingStore((state) => state.cadence)
  const tier = tiers.find(({ id }) => id === selectedTierId) ?? tiers[0]

  if (!tier) {
    return null
  }

  const rows = ledgerRows({ tier, cadence })

  return (
    <article className={styles.card}>
      <header className={styles.cardHeader}>
        <h2 className={styles.eyebrow}>
          {`Where ${monthlyPrice({ tier, cadence })} a month goes`}
        </h2>
        <span className={styles.cornerNote}>{tier.name}</span>
      </header>
      <div className={styles.cardBody}>
        <div
          className={styles.splitBar}
          role="img"
          aria-label="How the monthly contribution splits across the four costs below"
          style={{
            gridTemplateColumns: LEDGER_SPLIT.map(({ weight }) => `${weight}fr`).join(' '),
          }}
        >
          {LEDGER_SPLIT.map(({ label, tone }) => (
            <span key={label} className={`${styles.splitSegment} ${TONE_CLASS[tone]}`} />
          ))}
        </div>
        <ul className={styles.ledgerRows}>
          {rows.map(({ label, amount, tone }) => (
            <li key={label} className={styles.ledgerRow}>
              <span className={styles.ledgerLabel}>
                <span className={`${styles.ledgerSwatch} ${TONE_CLASS[tone]}`} aria-hidden="true" />
                {label}
              </span>
              <span className={styles.ledgerAmount}>{amount}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}

const StatusCard = () => (
  <article className={styles.card}>
    <header className={styles.cardHeader}>
      <h2 className={styles.eyebrow}>Service status</h2>
      <span className={styles.cornerNote}>refreshed 40s ago</span>
    </header>
    <ul className={styles.statusRows}>
      {STATUS_ROWS.map(({ label, value, live }) => (
        <li key={label} className={styles.statusRow}>
          <span className={styles.statusLabel}>{label}</span>
          {live ? (
            <span className={styles.statusLive}>
              <span className={styles.statusDot} aria-hidden="true" />
              {value}
            </span>
          ) : (
            <span className={styles.statusValue}>{value}</span>
          )}
        </li>
      ))}
    </ul>
    <div className={styles.uptime}>
      <p className={styles.uptimeHeader}>
        <span>Uptime, last 90 days</span>
        <span className={styles.uptimeFigure}>{UPTIME.percent}</span>
      </p>
      <div
        className={styles.uptimeStrip}
        role="img"
        aria-label={`Uptime ${UPTIME.percent} over the last 90 days, ${UPTIME.caption}`}
      >
        {UPTIME.cells.map(({ slice, state }) => (
          <span
            key={slice}
            className={state === 'maintenance' ? styles.uptimeMaintenance : styles.uptimeOk}
          />
        ))}
      </div>
      <p className={styles.uptimeCaption}>{UPTIME.caption}</p>
    </div>
  </article>
)

export const StatusBoard = ({ tiers }: { tiers: ReadonlyArray<Tier> }) => (
  <section id="status" className={styles.board} aria-label="Service status and cost breakdown">
    <LedgerCard tiers={tiers} />
    <StatusCard />
  </section>
)
