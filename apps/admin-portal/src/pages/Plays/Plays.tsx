import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { fetchPlaySync, type PlaySyncServer, type PlaysFilters } from '@/lib/playsApi'
import { errorMessage } from '@/pages/Plays/AsyncSection'
import { NeverPlayedPanel } from '@/pages/Plays/NeverPlayedPanel'
import { OverviewPanel } from '@/pages/Plays/OverviewPanel'
import { PlaysFilters as FilterBar } from '@/pages/Plays/PlaysFilters'
import { TAB_COPY } from '@/pages/Plays/playsCopy'
import { formatAgeSince, formatCount, monthYear } from '@/pages/Plays/playsFormat'
import { REFETCH_MS, SYNC_KEY } from '@/pages/Plays/playsQueries'
import { TopTitlesPanel } from '@/pages/Plays/TopTitlesPanel'
import { ViewerHistory } from '@/pages/Plays/ViewerHistory'
import { ViewersPanel } from '@/pages/Plays/ViewersPanel'
import { ViewTabs } from '@/pages/Plays/ViewTabs'
import { PLAYS_TABS, usePlaysPrefsStore, type PlaysTab } from '@/stores/playsPrefsStore'
import styles from '@/pages/Plays/Plays.module.scss'

// The viewer being read lives in the URL rather than the store, so a viewer's
// history is a link that can be sent, and a refresh lands on the same person.
const VIEWER_PARAM = 'user'

const parseAccountId = (value: string | null): number | null => {
  if (value === null || value.length === 0) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

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

const PlaysInner = () => {
  const rangeDays = usePlaysPrefsStore((state) => state.rangeDays)
  const setRangeDays = usePlaysPrefsStore((state) => state.setRangeDays)
  const host = usePlaysPrefsStore((state) => state.host)
  const setHost = usePlaysPrefsStore((state) => state.setHost)
  const kind = usePlaysPrefsStore((state) => state.kind)
  const setKind = usePlaysPrefsStore((state) => state.setKind)
  const quality = usePlaysPrefsStore((state) => state.quality)
  const setQuality = usePlaysPrefsStore((state) => state.setQuality)
  const tab = usePlaysPrefsStore((state) => state.tab)
  const setTab = usePlaysPrefsStore((state) => state.setTab)
  const [searchParams, setSearchParams] = useSearchParams()
  const viewer = parseAccountId(searchParams.get(VIEWER_PARAM))

  // One object per distinct filter set, so every query key and every panel
  // sees the same identity and a repaint does not refetch.
  const filters = useMemo<PlaysFilters>(
    () => ({ days: rangeDays, host, kind, quality }),
    [rangeDays, host, kind, quality],
  )

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

  // replace, not push: opening a viewer is a view tweak, and one history
  // entry per click would bury the page the admin arrived from
  const selectViewer = (accountId: number) => {
    setTab('viewers')
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params)
        next.set(VIEWER_PARAM, String(accountId))
        return next
      },
      { replace: true },
    )
  }
  const clearViewer = () => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params)
        next.delete(VIEWER_PARAM)
        return next
      },
      { replace: true },
    )
  }

  // A viewer named in the url is the view, whatever tab the browser last
  // remembered: a link to someone's history has to open on it. Choosing
  // another tab lets the viewer go, so the url and the strip never disagree.
  const activeTab: PlaysTab = viewer === null ? tab : 'viewers'
  const chooseTab = (next: PlaysTab) => {
    setTab(next)
    if (viewer !== null && next !== 'viewers') clearViewer()
  }

  const panelFor = (active: PlaysTab) => {
    if (active === 'overview') {
      return (
        <OverviewPanel
          filters={filters}
          onSelectViewer={selectViewer}
          onShowRanking={() => chooseTab('top')}
        />
      )
    }
    if (active === 'viewers') {
      return viewer === null ? (
        <ViewersPanel filters={filters} onSelect={selectViewer} />
      ) : (
        <ViewerHistory key={viewer} filters={filters} accountId={viewer} onBack={clearViewer} />
      )
    }
    if (active === 'top') return <TopTitlesPanel filters={filters} metric="plays" />
    if (active === 'rewatched') return <TopTitlesPanel filters={filters} metric="rewatches" />
    return <NeverPlayedPanel filters={filters} />
  }

  return (
    <AdminLayout showHardRefresh={false}>
      <main className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>Play history</h1>
          <p className={styles.lede}>
            Completed plays from every Plex server&apos;s own ledger, kept here for at least a year.
            A play counts once Plex marks it watched, so a film abandoned halfway is not in these
            figures.
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

        <ViewTabs tabs={TABS} active={activeTab} onSelect={chooseTab} label="Play history views">
          {panelFor(activeTab)}
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
