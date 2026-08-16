import { useQuery } from '@tanstack/react-query'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { fetchFleet, fetchIncidents, toHostSummary } from '@/lib/fleetApi'
import { HostCard } from '@/pages/Fleet/HostCard'
import styles from '@/pages/Fleet/Fleet.module.scss'

// One vitals tick. Anything slower and the page lags the collector it reports.
const REFETCH_MS = 30_000
const INCIDENT_HOURS = 24

const formatTimestamp = (isoTimestamp: string | null): string => {
  if (isoTimestamp === null) return 'never recorded'
  const at = new Date(isoTimestamp)
  return Number.isNaN(at.getTime()) ? isoTimestamp : at.toLocaleString()
}

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

        <section className={styles.section} aria-labelledby="fleet-hosts">
          <h2 className={styles.sectionTitle} id="fleet-hosts">
            Hosts
          </h2>
          {!!fleet.isPending && (
            <p className={styles.muted} aria-live="polite">
              Loading fleet status.
            </p>
          )}
          {!!fleet.isError && (
            <p className={styles.alert} role="alert">
              Could not reach the fleet monitor. No host state is available.
            </p>
          )}
          {!!fleet.data && (
            <ul className={styles.grid}>
              {fleet.data.hosts.map((host) => (
                <li key={host.name} className={styles.gridItem}>
                  <HostCard summary={toHostSummary(host)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="fleet-incidents">
          <h2 className={styles.sectionTitle} id="fleet-incidents">
            Open incidents
          </h2>
          {!!incidents.isPending && (
            <p className={styles.muted} aria-live="polite">
              Loading incidents.
            </p>
          )}
          {!!incidents.isError && (
            <p className={styles.alert} role="alert">
              Could not reach the incident feed.
            </p>
          )}
          {!!incidents.data &&
            (incidents.data.open.length > 0 ? (
              <ul className={styles.incidents}>
                {incidents.data.open.map((incident) => (
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
            ))}
        </section>
      </main>
    </AdminLayout>
  )
}

export const Fleet = () => (
  <AdminGate title="Westeroz — Fleet">
    <FleetInner />
  </AdminGate>
)
