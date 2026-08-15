import styles from '@/components/StatusBoard/StatusBoard.module.scss'

// Every figure here is a static placeholder until the bridge exposes real
// telemetry; swap the numbers in one place when it does. The framing stays on
// infrastructure (hardware, storage, uptime), never on content.
const LEDGER = {
  eyebrow: 'Where $14 a month goes',
  tierNote: 'Silver',
  rows: [
    { label: 'Server hardware', amount: '$5.20', share: 52, tone: 'accent' },
    { label: 'Storage & bandwidth', amount: '$4.60', share: 46, tone: 'bronze' },
    { label: 'Maintenance & uptime', amount: '$2.40', share: 24, tone: 'silver' },
    { label: 'Disk replacement reserve', amount: '$1.80', share: 18, tone: 'dim' },
  ],
} as const

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

const TONE_CLASS: Record<(typeof LEDGER.rows)[number]['tone'], string> = {
  accent: styles.toneAccent,
  bronze: styles.toneBronze,
  silver: styles.toneSilver,
  dim: styles.toneDim,
}

const LedgerCard = () => (
  <article className={styles.card}>
    <header className={styles.cardHeader}>
      <h2 className={styles.eyebrow}>{LEDGER.eyebrow}</h2>
      <span className={styles.cornerNote}>{LEDGER.tierNote}</span>
    </header>
    <div className={styles.cardBody}>
      <div
        className={styles.splitBar}
        role="img"
        aria-label="How the monthly contribution splits across the four costs below"
        style={{ gridTemplateColumns: LEDGER.rows.map(({ share }) => `${share}fr`).join(' ') }}
      >
        {LEDGER.rows.map(({ label, tone }) => (
          <span key={label} className={`${styles.splitSegment} ${TONE_CLASS[tone]}`} />
        ))}
      </div>
      <ul className={styles.ledgerRows}>
        {LEDGER.rows.map(({ label, amount, tone }) => (
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

export const StatusBoard = () => (
  <section id="status" className={styles.board} aria-label="Service status and cost breakdown">
    <LedgerCard />
    <StatusCard />
  </section>
)
