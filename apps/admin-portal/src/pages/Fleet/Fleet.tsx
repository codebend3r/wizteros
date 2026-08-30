import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { fetchFleet, fetchIncidents, fetchMetricHistory, toHostSummary } from '@/lib/fleetApi'
import { ChartTabs } from '@/pages/Fleet/ChartTabs'
import { HostCard } from '@/pages/Fleet/HostCard'
import { METRIC_COPY } from '@/pages/Fleet/metricCopy'
import { MetricChart } from '@/pages/Fleet/MetricChart'
import { MetricChartSkeleton } from '@/pages/Fleet/MetricChartSkeleton'
import { RangePicker } from '@/pages/Fleet/RangePicker'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { UpdateRateSlider } from '@/pages/Fleet/UpdateRateSlider'
import { CHART_KINDS, useFleetPrefsStore } from '@/stores/fleetPrefsStore'
import styles from '@/pages/Fleet/Fleet.module.scss'

// One vitals tick. Anything slower and the page lags the collector it reports.
// The chart queries' cadence is user-set through the slider instead: polling
// faster than a tick buys display latency (a fresh tick shows within the
// chosen interval), never extra data. It does not set a chart's own rate -
// each plots a point every second whatever the slider says, holding the last
// reading in between.
const REFETCH_MS = 30_000
const INCIDENT_HOURS = 24

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
  /** What the section says while the query is in flight. Omitted by a section
      whose own body holds the loading state - the charts stand in a
      placeholder shaped like the chart, and a line of text under it would be
      the same news twice. */
  readonly loadingLabel?: string
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
    {!!query.isPending && loadingLabel !== undefined && (
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
  const chartIntervalMs = useFleetPrefsStore((state) => state.updateIntervalMs)
  const setChartIntervalMs = useFleetPrefsStore((state) => state.setUpdateIntervalMs)
  const rangeMinutes = useFleetPrefsStore((state) => state.rangeMinutes)
  const setRangeMinutes = useFleetPrefsStore((state) => state.setRangeMinutes)
  const chartKind = useFleetPrefsStore((state) => state.chartKind)
  const setChartKind = useFleetPrefsStore((state) => state.setChartKind)
  // One query, for the chart on screen. Four charts polling at once cost four
  // requests an interval for three answers nobody was looking at, and at the
  // fastest stop that is forty a second against a NAS behind a Funnel.
  //
  // Kind and range are both in the key, so switching tabs or ranges back to
  // something already fetched paints from cache instead of emptying the chart
  // while a week reloads.
  const chart = useQuery({
    queryKey: ['fleet-metric', chartKind, rangeMinutes],
    queryFn: () => fetchMetricHistory({ kind: chartKind, minutes: rangeMinutes }),
    refetchInterval: chartIntervalMs,
  })
  const chartCopy = METRIC_COPY[chartKind]
  // Known from the fleet query, which is not the one being switched: the
  // placeholder can name the hosts its legend row will list, so that row takes
  // the height it will still take once the readings land.
  const hostNames = fleet.data?.hosts.map((host) => host.name) ?? []

  return (
    <AdminLayout showHardRefresh={false}>
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

        {/* One control pair for every chart, above all of them, rather than a
          copy per section: they read the same store, so per-section copies
          would move in lockstep and only add clutter. Outside the sections on
          purpose, so a failing query never takes its own tuning controls down
          with it. */}
        <div
          className={styles.controls}
          role="group"
          aria-label="Range and update rate, all charts"
        >
          <RangePicker minutes={rangeMinutes} onChange={setRangeMinutes} />
          <UpdateRateSlider intervalMs={chartIntervalMs} onChange={setChartIntervalMs} />
        </div>

        {/* One section for all four, because only one is on screen: a heading
          per chart would leave three headings pointing at nothing. The tab
          strip is what names the choice, and the panel is what changes. */}
        <AsyncSection
          id="fleet-charts"
          title="Charts"
          query={chart}
          errorSuffix={`No ${chartCopy.reading} history is available.`}
          controls={
            <ChartTabs kinds={CHART_KINDS} active={chartKind} onSelect={setChartKind}>
              {!!chart.data && (
                <MetricChart
                  // remounted per kind on purpose: the per-second trail belongs
                  // to the chart it was collected for, and carrying a CPU trail
                  // into the network tab would draw percentages as bytes
                  key={chartKind}
                  hosts={chart.data.hosts}
                  windowMinutes={chart.data.window_minutes}
                  unit={chart.data.unit}
                  copy={chartCopy}
                />
              )}
              {/* No data for this tab and range yet, and no error to explain
                why: hold the chart's shape rather than collapsing the page and
                pushing everything below it up for a moment. A cached kind or
                range paints straight from cache and never lands here. */}
              {!chart.data && !chart.isError && (
                <MetricChartSkeleton
                  copy={chartCopy}
                  windowMinutes={rangeMinutes}
                  hostNames={hostNames}
                />
              )}
            </ChartTabs>
          }
        >
          {() => null}
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
