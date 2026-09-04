import { useQuery } from '@tanstack/react-query'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { Preloader } from '@/components/Preloader/Preloader'
import { fetchAllEvents, fetchMembers, loadErrorMessage } from '@/lib/adminApi'
import { fetchIncidents } from '@/lib/fleetApi'
import { currentIncome, monthlySeries, toIncomeEvents } from '@/lib/income'
import { EventTimeline } from '@/pages/Income/EventTimeline'
import { GrowthChart } from '@/pages/Income/GrowthChart'
import { IncomeHero } from '@/pages/Income/IncomeHero'
import { IncomeTable } from '@/pages/Income/IncomeTable'
import { MovementsChart } from '@/pages/Income/MovementsChart'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/Income/Income.module.scss'

// How far back to ask the fleet monitor for outages: two years, well under
// its own five-year ceiling, and further back than the member log reaches.
const OUTAGE_HOURS = 24 * 365 * 2

export const INCOME_LOG_QUERY_KEY = ['member-log'] as const

const errorText = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'

const IncomeInner = () => {
  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => fetchMembers(),
    staleTime: 5 * 60 * 1000,
  })
  const log = useQuery({ queryKey: INCOME_LOG_QUERY_KEY, queryFn: fetchAllEvents })
  const outages = useQuery({
    queryKey: ['fleet-incidents', OUTAGE_HOURS],
    queryFn: () => fetchIncidents({ hours: OUTAGE_HOURS }),
  })

  // One clock per render, so the headline and the last month cannot disagree.
  const now = Date.now()
  const events = toIncomeEvents({
    events: log.data ?? [],
    outages: outages.data?.recent ?? [],
  })
  const income = members.data ? currentIncome({ members: members.data, now }) : null
  const series = members.data ? monthlySeries({ members: members.data, events, now }) : []
  const previous = series.length >= 2 ? series[series.length - 2] : undefined

  return (
    <AdminLayout>
      <main className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Income</h1>
          <p className={styles.lede}>
            What the subscribers add up to each month, priced at the tier each one holds today.
          </p>
        </header>

        {members.isPending && <Preloader message="Loading members… (this can take ~15s)" />}
        {members.isError && (
          <p className={styles.alert} role="alert">
            {loadErrorMessage(members.error)}
          </p>
        )}
        {!!income && <IncomeHero income={income} previous={previous} />}

        {log.isError && (
          <p className={styles.alert} role="alert">
            History is unavailable: {errorText(log.error)}. Today&apos;s figure stands on the
            members list alone; the months and the timeline need the bridge&apos;s event feed, which
            an older bridge does not serve.
          </p>
        )}
        {outages.isError && (
          <p className={styles.muted}>
            Outages could not be read from the fleet monitor, so the timeline lists member events
            only.
          </p>
        )}

        {!!members.data && (
          <>
            <section className={styles.section} aria-labelledby="income-growth">
              <h2 className={styles.sectionTitle} id="income-growth">
                Growth
              </h2>
              <GrowthChart months={series} />
            </section>
            <section className={styles.section} aria-labelledby="income-movements">
              <h2 className={styles.sectionTitle} id="income-movements">
                What moved it
              </h2>
              <MovementsChart months={series} />
              <IncomeTable months={series} />
            </section>
            <section className={styles.section} aria-labelledby="income-timeline">
              <h2 className={styles.sectionTitle} id="income-timeline">
                Timeline
              </h2>
              <EventTimeline events={events} />
            </section>
          </>
        )}
      </main>
    </AdminLayout>
  )
}

export const Income = () => (
  <AdminGate title="Westeroz: Income">
    <IncomeInner />
  </AdminGate>
)
