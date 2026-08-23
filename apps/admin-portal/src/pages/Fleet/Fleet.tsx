import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { fetchCpuHistory, fetchFleet, fetchIncidents, toHostSummary } from '@/lib/fleetApi'
import { CpuChart } from '@/pages/Fleet/CpuChart'
import { HostCard } from '@/pages/Fleet/HostCard'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { UpdateRateSlider } from '@/pages/Fleet/UpdateRateSlider'
import { useFleetPrefsStore } from '@/stores/fleetPrefsStore'
import styles from '@/pages/Fleet/Fleet.module.scss'

// One vitals tick. Anything slower and the page lags the collector it reports.
// The chart's own cadence is user-set through the slider instead: polling
// faster than a tick buys display latency (a fresh tick shows within the
// chosen interval), never extra data.
const REFETCH_MS = 30_000
const INCIDENT_HOURS = 24
const CPU_WINDOW_MINUTES = 60

const FALLBACK_ERROR = 'Could not reach the fleet monitor.'

const formatTimestamp = (isoTimestamp: string | null): string => {
  if (isoTimestamp === null) return 'never recorded'
  const at = new Date(isoTimestamp)
  return Number.isNaN(at.getTime()) ? isoTimestamp : at.toLocaleString()
}

/** What actually went wrong, not a guess.
 *
 * `fetchFleet` composes precise messages - an unset VITE_FLEET_BASE, a schema
 * the monitor answered with - and collapsing them all into "could not reach
 * the monitor" both loses the diagnostic and is wrong for a monitor that
 * answered fine.
 */
const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_ERROR

type AsyncSectionProps<T> = {
  readonly id: string
  readonly title: string
  readonly query: UseQueryResult<T>
  readonly loadingLabel: string
  readonly errorSuffix: string
  /** Rendered under the title in every query state: a control that tunes the
      query must stay reachable while that query is loading or failing. */
  readonly controls?: ReactNode
  readonly children: (data: T) => ReactNode
}

/** A section that says which of loading, failed, or loaded it is showing.
 *
 * Both sections on this page need all three states, and the page's whole
 * thesis is that history must never be presented as the present. Writing the
 * triple twice invites the two to drift, and a section that silently renders
 * nothing while a query is in flight reads as a monitor with nothing to report.
 */
const AsyncSection = <T,>({
  id,
  title,
  query,
  loadingLabel,
  errorSuffix,
  controls,
  children,
}: AsyncSectionProps<T>) => (
  <section className={styles.section} aria-labelledby={id}>
    <h2 className={styles.sectionTitle} id={id}>
      {title}
    </h2>
    {controls}
    {!!query.isPending && (
      <p className={styles.muted} aria-live="polite">
        {loadingLabel}
      </p>
    )}
    {!!query.isError && (
      <p className={styles.alert} role="alert">
        {`${errorMessage(query.error)} ${errorSuffix}`}
      </p>
    )}
    {!!query.data && children(query.data)}
  </section>
)

const FleetInner = () => {
  const fleet = useQuery({
    queryKey: ['fleet'],
    queryFn: fetchFleet,
    refetchInterval: REFETCH_MS,
  })
  const incidents = useQuery({
    queryKey: ['fleet-incidents', INCIDENT_HOURS],
    queryFn: () => fetchIncidents({ hours: INCIDENT_HOURS }),
    refetchInterval: REFETCH_MS,
  })
  const cpuIntervalMs = useFleetPrefsStore((state) => state.updateIntervalMs)
  const setCpuIntervalMs = useFleetPrefsStore((state) => state.setUpdateIntervalMs)
  const cpuHistory = useQuery({
    queryKey: ['fleet-cpu', CPU_WINDOW_MINUTES],
    queryFn: () => fetchCpuHistory({ minutes: CPU_WINDOW_MINUTES }),
    refetchInterval: cpuIntervalMs,
  })

  return (
    <AdminLayout>
      <main className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Fleet</h1>
          {!!fleet.data && (
            <p className={styles.heartbeat}>
              Collector heartbeat: {formatTimestamp(fleet.data.collected_at)}
            </p>
          )}
          {/* Collector liveness, which is a different fact from any host's own
            metric ages: this one says the process itself stopped reporting. */}
          {(fleet.data?.stale ?? false) && (
            <p className={styles.alert} role="alert">
              The collector has stopped reporting. It runs on vermithor and cannot report that box
              being down, so treat every reading below as history rather than the present.
            </p>
          )}
        </header>

        <AsyncSection
          id="fleet-cpu"
          title="CPU"
          query={cpuHistory}
          loadingLabel="Loading CPU history."
          errorSuffix="No CPU history is available."
          controls={<UpdateRateSlider intervalMs={cpuIntervalMs} onChange={setCpuIntervalMs} />}
        >
          {(data) => (
            <CpuChart
              hosts={data.hosts}
              windowMinutes={data.window_minutes}
              updateEveryMs={cpuIntervalMs}
            />
          )}
        </AsyncSection>

        <AsyncSection
          id="fleet-hosts"
          title="Hosts"
          query={fleet}
          loadingLabel="Loading fleet status."
          errorSuffix="No host state is available."
        >
          {(data) =>
            data.hosts.length > 0 ? (
              <ul className={styles.grid}>
                {data.hosts.map((host, index) => (
                  <li key={host.name} className={styles.gridItem}>
                    <HostCard summary={toHostSummary(host)} className={seriesClass(index)} />
                  </li>
                ))}
              </ul>
            ) : (
              /* an empty ul renders as nothing at all, which reads as a page
                still loading rather than as a monitor with no hosts */
              <p className={styles.muted}>The fleet monitor reported no hosts.</p>
            )
          }
        </AsyncSection>

        <AsyncSection
          id="fleet-incidents"
          title="Open incidents"
          query={incidents}
          loadingLabel="Loading incidents."
          errorSuffix="No incident state is available."
        >
          {(data) =>
            data.open.length > 0 ? (
              <ul className={styles.incidents}>
                {data.open.map((incident) => (
                  <li key={incident.id} className={styles.incident}>
                    <span className={styles.incidentTarget}>{incident.target}</span>
                    <span className={styles.incidentReason}>
                      {incident.reason.length > 0 ? incident.reason : 'reason not recorded'}
                    </span>
                    <time className={styles.incidentTime} dateTime={incident.opened_at}>
                      {formatTimestamp(incident.opened_at)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>No open incidents.</p>
            )
          }
        </AsyncSection>
      </main>
    </AdminLayout>
  )
}

export const Fleet = () => (
  <AdminGate title="Westeroz — Fleet">
    <FleetInner />
  </AdminGate>
)
