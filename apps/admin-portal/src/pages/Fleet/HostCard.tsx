import {
  formatAge,
  formatBytes,
  type ContainerSummary,
  type HostStatus,
  type HostSummary,
} from '@/lib/fleetApi'
import styles from '@/pages/Fleet/HostCard.module.scss'

type HostCardProps = {
  readonly summary: HostSummary
  /** The series class binding this host to its CPU-chart colour; the card
      border wears it so card and line read as the same host at a glance. */
  readonly className?: string
}

// null is "print no status line", not "no status": a warn host states its case
// through the disk and load figures below and the stale note beside them,
// which are the readings the monitor judged, rather than through a summary
// word sitting over them.
const STATUS_LABEL: Record<HostStatus, string | null> = {
  ok: 'Healthy',
  warn: null,
  unknown: 'Not collected',
}

// The status word is computed from disk and load, and disk is a slow-tier
// metric: on a host whose slow probe died it is as frozen as the numbers under
// it. Say so in the word itself, so the most prominent text on the card cannot
// assert the present tense while the note below scopes only the readings.
const STALE_STATUS_SUFFIX = ' as of the last reading'

// The monitor names the family that fell silent in its own metric namespace.
// These are the same words a reader already sees on the card, so the note
// reads as English rather than as a key out of the database.
const FAMILY_LABEL: Record<string, string> = {
  container: 'container state',
  cpu: 'CPU',
  disk: 'disk',
  gpu: 'GPU',
  inotify: 'inotify',
  load: 'load',
  mem: 'memory',
  net: 'network',
  procs: 'process counts',
  temp: 'temperature',
  uptime: 'uptime',
}

/** What to call the silent family. Unmapped families print their raw name:
    the monitor gains metrics faster than this map does, and "cpu2" is still a
    truthful answer to what stopped reporting. */
const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? family

/** A container's state in words.
 *
 * A container with no healthcheck gets a bare "Up" and no health claim either
 * way: "Up, healthy" would assert a check passed that was never run, and "Up,
 * unhealthy" would assert one failed. Most containers on this fleet declare no
 * healthcheck at all, so this is the common case, not the edge one.
 */
const containerLabel = (container: ContainerSummary): string => {
  if (!container.up) return 'Down'
  if (!container.hasHealthcheck) return 'Up'
  return container.healthy ? 'Up, healthy' : 'Up, unhealthy'
}

/** What the collapsed roster says about itself.
 *
 * An absent roster is not an empty one: a Docker endpoint that is not
 * reporting is missing data, and printing "0 up" over it would read as a host
 * deliberately running nothing. Down containers are counted into the summary
 * so shutting the section hides the names, never the problem.
 */
const containerTally = (containers: readonly ContainerSummary[]): string => {
  if (containers.length === 0) return 'not collected'
  const down = containers.filter((container) => !container.up).length
  return down > 0 ? `${containers.length}, ${down} down` : `${containers.length} up`
}

/** A usage reading, with its absolute size where the collector recorded one. */
const usage = ({ percent, total }: { percent: number | null; total: number | null }): string => {
  if (percent === null) return '--'
  return total === null ? `${percent}%` : `${percent}% of ${formatBytes(total)}`
}

/** How far along its track the bar is drawn. Clamped, so a reading outside the
    scale stays inside the track instead of overflowing it. */
const barWidth = (percent: number): string => `${Math.max(0, Math.min(percent, 100))}%`

export const HostCard = ({ summary, className }: HostCardProps) => {
  // A never-collected host is already unqualified-proof: its label is the
  // absence itself. Only a collected host can carry a stale present tense.
  const staleStatus = summary.status !== 'unknown' && summary.metricsStale
  const label = STATUS_LABEL[summary.status]
  // One text node, not a word plus a decorative span: the qualification has to
  // be part of the status itself, not something a reader can visually skip.
  const statusText = label === null ? null : `${label}${staleStatus ? STALE_STATUS_SUFFIX : ''}`

  return (
    <article
      className={className ? `${styles.card} ${className}` : styles.card}
      data-status={summary.status}
    >
      <header className={styles.header}>
        <h3 className={styles.name}>{summary.name}</h3>
        {/* status is stated in text, never by color alone */}
        {!!statusText && (
          <p className={staleStatus ? `${styles.status} ${styles.statusStale}` : styles.status}>
            {statusText}
          </p>
        )}
      </header>

      <p className={styles.ip}>{summary.ip}</p>

      {/* not "nothing has ever been recorded": after retention prunes a host's
        samples at 7 days this state is reached again, and the stronger claim
        would then be false */}
      {summary.status === 'unknown' && (
        <p className={styles.note}>
          No current readings for this host. Every reading below is absent, not zero.
        </p>
      )}

      {!!staleStatus && (
        <p className={styles.note}>
          {/* the age is absent when nothing reported inside the monitor's age
            window, or when a clock step left a reading stamped ahead of now;
            "unknown old" would be worse than saying it cannot be dated */}
          {summary.stalestFamilyAgeSeconds === null || summary.stalestFamily === null ? (
            'Stale readings: nothing on this host has reported recently enough to date these values.'
          ) : (
            <>
              {/* naming the family is the whole point of this sentence. It used
                to blame disk and temperature every time, which was wrong on
                every card where something else had stopped: meleys sat behind
                "Disk and temperature refresh every 15 minutes" while both were
                seven minutes old and a dead VPN counter was the stale one. */}
              Stale readings: {familyLabel(summary.stalestFamily)} has not reported for{' '}
              {formatAge(summary.stalestFamilyAgeSeconds)}. Anything below that comes from it is
              history, not the present.
            </>
          )}
        </p>
      )}

      <dl className={styles.metrics}>
        <div className={styles.row}>
          {/* the core count is observed, not assumed, so it is worth showing:
            it is what the load figure beside it was divided by */}
          <dt>Load per core{summary.cores === null ? '' : ` (${summary.cores})`}</dt>
          <dd>{summary.loadPerCore === null ? '--' : summary.loadPerCore.toFixed(2)}</dd>
        </div>
        <div className={styles.row}>
          <dt>Memory</dt>
          <dd>{usage({ percent: summary.memoryPercent, total: summary.memoryTotalBytes })}</dd>
        </div>
        <div className={`${styles.row} ${styles.diskRow}`}>
          <dt>Disk</dt>
          <dd className={styles.diskValue}>
            {usage({ percent: summary.diskPercent, total: summary.diskTotalBytes })}
            {/* The bar restates the percentage printed beside it, so it is a
              second reading of one fact rather than the only one, and it is
              hidden from the accessibility tree instead of repeating that
              number there. It carries no judgment of its own either: how full
              is too full is the monitor's call, not this card's. */}
            {summary.diskPercent !== null && (
              <span className={styles.gauge} aria-hidden="true">
                <span
                  className={styles.gaugeFill}
                  style={{ width: barWidth(summary.diskPercent) }}
                />
              </span>
            )}
          </dd>
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
        <details className={styles.containers}>
          {/* The summary carries the count and the down tally, so collapsing
            hides the roster but never the finding: a host with something down,
            or with no container data at all, says so while shut. */}
          <summary className={styles.containersSummary}>
            <span className={styles.containersTitle}>Containers</span>
            <span className={styles.containersTally}>{containerTally(summary.containers)}</span>
          </summary>
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
        </details>
      )}
    </article>
  )
}
