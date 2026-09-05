import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon/Icon'
import { IconTile, type IconTileTone } from '@/components/IconTile/IconTile'
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
      border and header band wear it so card and line read as the same host at
      a glance. */
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

// The tile beside the status word. Never collected is an absence, not a
// health, so it wears the muted tone: a green tile on it would let a reader's
// eye file the card as fine before the word beside it said otherwise.
const STATUS_MARK: Record<HostStatus, { name: IconName; tone: IconTileTone } | null> = {
  ok: { name: 'check', tone: 'ok' },
  warn: null,
  unknown: { name: 'help', tone: 'muted' },
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

/** One reading, split into the figure a reader scans for and the qualifier
 *  that scopes it.
 *
 * The two used to be one string ("22% of 31.3 GB"), which set the number and
 * its denominator at the same size and left neither one scannable. They are
 * separate nodes so the figure can carry the weight and the qualifier can step
 * back out of the way.
 */
type Reading = {
  readonly value: string
  /** Empty when the reading needs no scoping; the line is then not rendered. */
  readonly context: string
}

/** A usage reading, with its absolute size where the collector recorded one.
    An absent percentage takes no qualifier: "of 83.7 TB" under a dash would
    describe a disk whose fullness is exactly what is missing. */
const usageReading = ({
  percent,
  total,
}: {
  percent: number | null
  total: number | null
}): Reading => {
  if (percent === null) return { value: '--', context: '' }
  return { value: `${percent}%`, context: total === null ? '' : `of ${formatBytes(total)}` }
}

/** How far along its track the bar is drawn. Clamped, so a reading outside the
    scale stays inside the track instead of overflowing it. */
const barWidth = (percent: number): string => `${Math.max(0, Math.min(percent, 100))}%`

/** A qualification beside the readings, led by a warning mark.
 *
 * The mark is decoration: the sentence is the warning, and it opens with the
 * word that names the problem, so a reader who never sees the triangle loses
 * nothing.
 */
const Note = ({ children }: { readonly children: ReactNode }) => (
  <p className={styles.note}>
    <Icon name="warn" className={styles.noteMark} />
    <span>{children}</span>
  </p>
)

type StatProps = {
  readonly label: string
  /** The glyph on the tile beside the label, in the host's colour. */
  readonly icon: IconName
  readonly reading: Reading
  /** The share the meter fills, or null for a reading with no meter. Only the
      two capacity readings carry one: a bar under a load average would need a
      ceiling this card has no business inventing, and a bar under 100% uptime
      would be full on every card in the fleet. */
  readonly meterPercent: number | null
}

/** One reading as three tiers: what it is, what it says, what it is measured
    against. The label and the qualifier recede so the figure can be the thing
    the eye lands on; the tile ahead of them is a faster handle on the label,
    not a fourth tier. */
const Stat = ({ label, icon, reading, meterPercent }: StatProps) => (
  <div className={styles.stat}>
    <IconTile name={icon} tone="series" size="lg" className={styles.statTile} />
    <dt className={styles.statLabel}>{label}</dt>
    <dd className={styles.statValue}>
      <span className={styles.figure}>{reading.value}</span>
      {reading.context.length > 0 && <span className={styles.qualifier}>{reading.context}</span>}
      {/* The meter restates the percentage printed above it, so it is a second
        reading of one fact rather than the only one, and it is hidden from the
        accessibility tree instead of repeating that number there. It carries
        no judgment of its own either: how full is too full is the monitor's
        call, not this card's. */}
      {meterPercent !== null && (
        <span className={styles.meter} aria-hidden="true">
          <span className={styles.meterFill} style={{ width: barWidth(meterPercent) }} />
        </span>
      )}
    </dd>
  </div>
)

export const HostCard = ({ summary, className }: HostCardProps) => {
  // A never-collected host is already unqualified-proof: its label is the
  // absence itself. Only a collected host can carry a stale present tense.
  const staleStatus = summary.status !== 'unknown' && summary.metricsStale
  const label = STATUS_LABEL[summary.status]
  const mark = STATUS_MARK[summary.status]
  // One text node, not a word plus a decorative span: the qualification has to
  // be part of the status itself, not something a reader can visually skip.
  const statusText = label === null ? null : `${label}${staleStatus ? STALE_STATUS_SUFFIX : ''}`
  // The core count is observed, not assumed, so it is worth showing: it is
  // what the load figure above it was divided by.
  const coreContext =
    summary.cores === null ? '' : `${summary.cores} ${summary.cores === 1 ? 'core' : 'cores'}`
  const hasFooter = summary.hasGpu || summary.hasDocker

  return (
    <article
      className={className ? `${styles.card} ${className}` : styles.card}
      data-status={summary.status}
    >
      <header className={styles.header}>
        <h3 className={styles.name}>{summary.name}</h3>
        <p className={styles.ip}>{summary.ip}</p>
        {/* status is stated in text, never by color alone: the tile restates
          the word beside it and is hidden from the accessibility tree */}
        {!!statusText && (
          <p className={staleStatus ? `${styles.status} ${styles.statusStale}` : styles.status}>
            {!!mark && <IconTile name={mark.name} tone={mark.tone} size="sm" />}
            {statusText}
          </p>
        )}
      </header>

      <div className={styles.body}>
        {/* not "nothing has ever been recorded": after retention prunes a
          host's samples at 7 days this state is reached again, and the
          stronger claim would then be false */}
        {summary.status === 'unknown' && (
          <Note>No current readings for this host. Every reading below is absent, not zero.</Note>
        )}

        {!!staleStatus && (
          <Note>
            {/* the age is absent when nothing reported inside the monitor's age
              window, or when a clock step left a reading stamped ahead of now;
              "unknown old" would be worse than saying it cannot be dated */}
            {summary.stalestFamilyAgeSeconds === null || summary.stalestFamily === null ? (
              'Stale readings: nothing on this host has reported recently enough to date these values.'
            ) : (
              <>
                {/* naming the family is the whole point of this sentence. It
                  used to blame disk and temperature every time, which was wrong
                  on every card where something else had stopped: meleys sat
                  behind "Disk and temperature refresh every 15 minutes" while
                  both were seven minutes old and a dead VPN counter was the
                  stale one. */}
                Stale readings: {familyLabel(summary.stalestFamily)} has not reported for{' '}
                {formatAge(summary.stalestFamilyAgeSeconds)}. Anything below that comes from it is
                history, not the present.
              </>
            )}
          </Note>
        )}

        {/* The two metered readings share the first row and the two bare ones
          the second, so every cell in a row is the same height and the labels
          line up straight across. The pair carrying bars also leads, because
          on this fleet the disk figures are the finding. */}
        <dl className={styles.stats}>
          <Stat
            label="Memory"
            icon="memory"
            reading={usageReading({
              percent: summary.memoryPercent,
              total: summary.memoryTotalBytes,
            })}
            meterPercent={summary.memoryPercent}
          />
          <Stat
            label="Disk"
            icon="disk"
            reading={usageReading({ percent: summary.diskPercent, total: summary.diskTotalBytes })}
            meterPercent={summary.diskPercent}
          />
          <Stat
            label="Load / core"
            icon="gauge"
            reading={{
              value: summary.loadPerCore === null ? '--' : summary.loadPerCore.toFixed(2),
              context: coreContext,
            }}
            meterPercent={null}
          />
          <Stat
            label="Uptime"
            icon="pulse"
            // never measured is unknown, never a perfect score
            reading={{
              value: summary.uptimePercent === null ? 'Unknown' : `${summary.uptimePercent}%`,
              context: 'last 24 hours',
            }}
            meterPercent={null}
          />
        </dl>
      </div>

      {/* Everything a host either has or does not, kept out of the stat grid
        so the grid is the same four readings on every card. A GPU row sitting
        among the metrics used to shift the containers line down by one on the
        two hosts that have a render node, and nothing below it lined up
        across the row. */}
      {!!hasFooter && (
        <footer className={styles.footer}>
          {!!summary.hasGpu && (
            <p className={styles.meta}>
              <IconTile name="gpu" tone="muted" size="sm" />
              <span className={styles.metaLabel}>GPU</span>
              <span className={styles.metaValue}>Intel iGPU present</span>
            </p>
          )}

          {!!summary.hasDocker && (
            <details className={styles.containers}>
              {/* The summary carries the count and the down tally, so collapsing
                hides the roster but never the finding: a host with something
                down, or with no container data at all, says so while shut. */}
              <summary className={styles.containersSummary}>
                <IconTile name="box" tone="muted" size="sm" />
                <span className={styles.metaLabel}>Containers</span>
                <span className={styles.metaValue}>{containerTally(summary.containers)}</span>
                {/* drawn rather than left to the native marker, which
                  `display: grid` takes away from a summary */}
                <Icon name="chevron" size={12} strokeWidth={2} className={styles.chevron} />
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
                <Note>
                  Container data not collected. The Docker endpoint is not reporting, so this is
                  missing data rather than a host with no containers.
                </Note>
              )}
            </details>
          )}
        </footer>
      )}
    </article>
  )
}
