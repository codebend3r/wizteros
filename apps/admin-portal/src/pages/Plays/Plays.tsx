import { useQuery } from '@tanstack/react-query'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { fetchPlaySync, type PlaySyncServer } from '@/lib/playsApi'
import { errorMessage } from '@/pages/Plays/AsyncSection'
import { NeverPlayedPanel } from '@/pages/Plays/NeverPlayedPanel'
import { OverviewPanel } from '@/pages/Plays/OverviewPanel'
import { PlaysFilters as FilterBar } from '@/pages/Plays/PlaysFilters'
import { TAB_COPY } from '@/pages/Plays/playsCopy'
import { formatAgeSince, formatCount, monthYear } from '@/pages/Plays/playsFormat'
import { PLAYS_TABS, usePlaysParams, type PlaysTab } from '@/pages/Plays/playsParams'
import { REFETCH_MS, SYNC_KEY } from '@/pages/Plays/playsQueries'
import { TitleHistory } from '@/pages/Plays/TitleHistory'
import { TopTitlesPanel } from '@/pages/Plays/TopTitlesPanel'
import { ViewerHistory } from '@/pages/Plays/ViewerHistory'
import { ViewersPanel } from '@/pages/Plays/ViewersPanel'
import { ViewTabs } from '@/pages/Plays/ViewTabs'
import styles from '@/pages/Plays/Plays.module.scss'

const TABS = PLAYS_TABS.map((id) => ({ id, title: TAB_COPY[id].title, icon: TAB_COPY[id].icon }))

/** "vhagar (refused) and vermithor (timeout)": the servers whose last pass
    failed, with the reason the monitor recorded. */
const failedList = (servers: readonly PlaySyncServer[]): string => {
  const names = servers.map((server) =>
    server.last_error === null ? server.host : `${server.host} (${server.last_error})`,
  )
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

const newest = (stamps: readonly string[]): string | null =>
  stamps.reduce<string | null>(
    (best, stamp) => (best === null || stamp > best ? stamp : best),
    null,
  )

const oldest = (stamps: readonly string[]): string | null =>
  stamps.reduce<string | null>(
    (best, stamp) => (best === null || stamp < best ? stamp : best),
    null,
  )

type SyncLineProps = {
  readonly servers: readonly PlaySyncServer[]
  /** When the status was read, so "3 minutes ago" is measured from the
      answer rather than from whenever the page happens to repaint. */
  readonly readAt: number
}

/** One sentence on where the ledger stands, and one alert when a server is
    not being reached. */
const SyncLine = ({ servers, readAt }: SyncLineProps) => {
  const synced = servers.flatMap((server) =>
    server.history_synced_at === null ? [] : [server.history_synced_at],
  )
  const plays = servers.reduce((sum, server) => sum + server.plays, 0)
  const since = oldest(
    servers.flatMap((server) => (server.history_since === null ? [] : [server.history_since])),
  )
  const failed = servers.filter((server) => !server.reachable || server.last_error !== null)

  return (
    <>
      {synced.length === 0 && plays === 0 ? (
        // Not an empty ledger: a ledger nobody has filled yet. The first pass
        // reads a year of history from every server and takes a few minutes.
        <p className={styles.sync} aria-live="polite">
          The collector is backfilling play history from {formatCount(servers.length)} servers.
          Figures appear once the first pass lands.
        </p>
      ) : (
        <p className={styles.sync}>
          Synced {formatAgeSince({ iso: newest(synced), now: readAt })} ago,{' '}
          {formatCount(servers.length)} servers, {formatCount(plays)} completed plays since{' '}
          {monthYear(since)}.
        </p>
      )}
      {failed.length > 0 && (
        <p className={styles.alert} role="alert">
          Sync failed on {failedList(failed)}. Figures for {failed.length === 1 ? 'it' : 'them'}{' '}
          stop at the last successful pass.
        </p>
      )}
    </>
  )
}

/** The view a title was opened from, as the back button names it. */
const backTo = (tab: PlaysTab): string => TAB_COPY[tab].title.toLowerCase()

const PlaysInner = () => {
  // Every knob on this page is a query parameter, so a refresh, a bookmark
  // and a pasted link all reopen the exact view that was on screen.
  const {
    tab,
    filters,
    viewer,
    title,
    page,
    search,
    setRangeDays,
    setKind,
    setQuality,
    setHost,
    setTab,
    openViewer,
    closeViewer,
    openTitle,
    closeTitle,
    setPage,
    setSearch,
  } = usePlaysParams()

  const sync = useQuery({
    queryKey: SYNC_KEY,
    queryFn: fetchPlaySync,
    refetchInterval: REFETCH_MS,
  })
  const hosts =
    sync.data?.servers.map((server) => ({
      host: server.host,
      label: server.friendly_name ?? server.host,
    })) ?? []

  const panelFor = (active: PlaysTab) => {
    if (active === 'overview') {
      return (
        <OverviewPanel
          filters={filters}
          onSelectViewer={openViewer}
          onSelectTitle={openTitle}
          onShowRanking={() => setTab('top')}
        />
      )
    }
    if (active === 'viewers') {
      return viewer === null ? (
        <ViewersPanel filters={filters} onSelect={openViewer} />
      ) : (
        <ViewerHistory
          key={viewer}
          filters={filters}
          accountId={viewer}
          page={page}
          onPageChange={setPage}
          onBack={closeViewer}
          onSelectTitle={openTitle}
        />
      )
    }
    if (active === 'top') {
      return <TopTitlesPanel filters={filters} metric="plays" onSelectTitle={openTitle} />
    }
    if (active === 'rewatched') {
      return <TopTitlesPanel filters={filters} metric="rewatches" onSelectTitle={openTitle} />
    }
    return (
      <NeverPlayedPanel
        filters={filters}
        page={page}
        onPageChange={setPage}
        search={search}
        onSearch={setSearch}
      />
    )
  }

  return (
    <AdminLayout showHardRefresh={false}>
      <main className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Play history</h1>
          <p className={styles.lede}>
            Completed plays from every Plex server&apos;s own ledger, kept here for at least a year.
            A play counts once Plex marks it watched, so a film abandoned halfway is not in these
            figures, and a viewing Plex marked watched twice counts once.
          </p>
          {!!sync.isPending && (
            <p className={styles.sync} aria-live="polite">
              Checking the collector.
            </p>
          )}
          {!!sync.isError && (
            <p className={styles.alert} role="alert">
              {`${errorMessage(sync.error)} Sync status is unavailable.`}
            </p>
          )}
          {!!sync.data && <SyncLine servers={sync.data.servers} readAt={sync.dataUpdatedAt} />}
        </header>

        {/* One toolbar for every view, outside the tabs and outside every
          section, so a failing query never takes down the controls that
          could fix it, and switching views never resets what is asked. */}
        <FilterBar
          filters={filters}
          hosts={hosts}
          onRange={setRangeDays}
          onKind={setKind}
          onQuality={setQuality}
          onHost={setHost}
        />

        <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Play history views">
          {title === null ? (
            panelFor(tab)
          ) : (
            // a title sits over whichever view opened it, and leads back to
            // that view rather than to a view of its own
            <TitleHistory
              key={title}
              filters={filters}
              titleKey={title}
              page={page}
              onPageChange={setPage}
              onBack={closeTitle}
              backLabel={viewer === null ? `Back to ${backTo(tab)}` : 'Back to the viewer'}
              onSelectViewer={openViewer}
            />
          )}
        </ViewTabs>
      </main>
    </AdminLayout>
  )
}

export const Plays = () => (
  <AdminGate title="Westeroz: Play history">
    <PlaysInner />
  </AdminGate>
)
