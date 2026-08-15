import { formatAge, formatBytes, type ContainerSummary, type HostSummary } from '@/lib/fleetApi'
import styles from '@/pages/Fleet/HostCard.module.scss'

type HostCardProps = {
  readonly summary: HostSummary
}

const STATUS_LABEL = {
  ok: 'Healthy',
  warn: 'Needs attention',
  unknown: 'Not collected',
} as const

const containerLabel = (container: ContainerSummary): string => {
  if (!container.up) return 'Down'
  return container.healthy ? 'Up, healthy' : 'Up, unhealthy'
}

/** A usage reading, with its absolute size where the collector recorded one. */
const usage = ({ percent, total }: { percent: number | null; total: number | null }): string => {
  if (percent === null) return '--'
  return total === null ? `${percent}%` : `${percent}% of ${formatBytes(total)}`
}

export const HostCard = ({ summary }: HostCardProps) => (
  <article className={styles.card} data-status={summary.status}>
    <header className={styles.header}>
      <h3 className={styles.name}>{summary.name}</h3>
      {/* status is stated in text, never by color alone */}
      <p className={styles.status}>{STATUS_LABEL[summary.status]}</p>
    </header>

    <p className={styles.ip}>{summary.ip}</p>

    {summary.status === 'unknown' && (
      <p className={styles.note}>
        Nothing has ever been recorded for this host. Every reading below is absent, not zero.
      </p>
    )}

    {summary.status !== 'unknown' && !!summary.metricsStale && (
      <p className={styles.note}>
        Stale readings: the oldest metric on this host is{' '}
        {formatAge(summary.oldestMetricAgeSeconds)} old. Disk and temperature refresh every 15
        minutes, so any frozen value below is history, not the present.
      </p>
    )}

    <dl className={styles.metrics}>
      <div className={styles.row}>
        <dt>Load per core</dt>
        <dd>{summary.loadPerCore === null ? '--' : summary.loadPerCore.toFixed(2)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Memory</dt>
        <dd>{usage({ percent: summary.memoryPercent, total: summary.memoryTotalBytes })}</dd>
      </div>
      <div className={styles.row}>
        <dt>Disk</dt>
        <dd>{usage({ percent: summary.diskPercent, total: summary.diskTotalBytes })}</dd>
      </div>
      {!!summary.hasGpu && (
        <div className={styles.row}>
          <dt>GPU</dt>
          <dd>Intel iGPU present</dd>
        </div>
      )}
      <div className={styles.row}>
        <dt>Uptime 24h</dt>
        {/* never measured is unknown, never a perfect score */}
        <dd>{summary.uptimePercent === null ? 'Unknown' : `${summary.uptimePercent}%`}</dd>
      </div>
    </dl>

    {!!summary.hasDocker && (
      <section className={styles.containers}>
        <h4 className={styles.containersTitle}>Containers</h4>
        {summary.containers.length > 0 ? (
          <ul className={styles.containerList}>
            {summary.containers.map((container) => (
              <li key={container.name} className={styles.container}>
                <span className={styles.containerName}>{container.name}</span>
                <span className={styles.containerState}>{containerLabel(container)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>
            Container data not collected. The Docker endpoint is not reporting, so this is missing
            data rather than a host with no containers.
          </p>
        )}
      </section>
    )}
  </article>
)
