import type { Tier } from '@/site.config'
import { monthlyAmount, monthlyPrice, type BillingCadence } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'
import styles from '@/components/StatusBoard/StatusBoard.module.scss'

// An illustrative allocation, not measured spending. The framing stays on
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

const STATUS_ROWS = ['Server availability', 'Transcode capacity', 'Request queue'] as const

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
        <p className={styles.uptimeCaption}>Illustrative allocation, not actual spending.</p>
        <div
          className={styles.splitBar}
          role="img"
          aria-label="Illustrative monthly contribution split across the four costs below"
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
      <span className={styles.cornerNote}>Not connected</span>
    </header>
    <ul className={styles.statusRows}>
      {STATUS_ROWS.map((label) => (
        <li key={label} className={styles.statusRow}>
          <span className={styles.statusLabel}>{label}</span>
          <span className={styles.statusValue}>Unverified</span>
        </li>
      ))}
    </ul>
    <div className={styles.uptime}>
      <p className={styles.uptimeHeader}>
        <span>Uptime</span>
        <span className={styles.uptimeFigure}>Unavailable</span>
      </p>
      <p className={styles.uptimeCaption}>Public telemetry is not connected.</p>
    </div>
  </article>
)

export const StatusBoard = ({ tiers }: { tiers: ReadonlyArray<Tier> }) => (
  <section id="status" className={styles.board} aria-label="Service status and cost breakdown">
    <LedgerCard tiers={tiers} />
    <StatusCard />
  </section>
)
