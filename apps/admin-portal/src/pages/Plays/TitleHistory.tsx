import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchTitleHistory,
  windowProse,
  type PlaysFilters,
  type TitleHistory as TitleHistoryPage,
  type TitleHistoryRow,
} from '@/lib/playsApi'
import { AsyncSection } from '@/pages/Plays/AsyncSection'
import { Pager } from '@/pages/Plays/Pager'
import { KIND_LABEL } from '@/pages/Plays/playsCopy'
import {
  episodeLabel,
  formatCount,
  formatDate,
  formatDateTime,
  qualityLabel,
  titleWithYear,
} from '@/pages/Plays/playsFormat'
import { PAGE_SIZE, REFETCH_MS, titleHistoryKey } from '@/pages/Plays/playsQueries'
import { StatTiles, type StatTile } from '@/pages/Plays/StatTiles'
import styles from '@/pages/Plays/DataTable.module.scss'

type TitleHistoryProps = {
  readonly filters: PlaysFilters
  /** The group key the monitor hands out with every ranked title and every
      viewer's row: a film, a show, an album, or a single unnamed item. */
  readonly titleKey: string
  /** The page being read, 1 based. It lives in the url beside the title, so
      a refresh comes back to the same page of the same history. */
  readonly page: number
  readonly onPageChange: (page: number) => void
  readonly onBack: () => void
  /** What the back button says, since a title can be opened from four of
      the five views and has to lead back to the one it came from. */
  readonly backLabel: string
  readonly onSelectViewer: (accountId: number) => void
}

/** A key nothing in the ledger answers to is a link older than the library
    it names, so the page says that rather than heading itself with a blank. */
const UNKNOWN_TITLE = 'A title the ledger no longer holds'

/** The item a row stands for, which is never the title above it: the episode
    with its code, the track, the film with its year. */
const item = (row: TitleHistoryRow): string => {
  if (row.kind === 'episode') {
    const code = episodeLabel({ parentIndex: row.parent_index, index: row.index })
    return [code, row.title].filter((part) => part.length > 0).join(' ')
  }
  if (row.kind === 'track') return row.title
  return titleWithYear({ title: row.title, year: row.year })
}

/** What scopes the title under its name: what kind of thing it is, and the
    artist behind an album. */
const scope = (data: TitleHistoryPage): string =>
  [data.kind === null ? '' : KIND_LABEL[data.kind].toLowerCase(), data.context ?? '']
    .filter((part) => part.length > 0)
    .join(', ')

/** How many distinct episodes or tracks the plays were spread over. A film
    has exactly one item, so the tile would say nothing there. */
const itemsTile = (data: TitleHistoryPage): readonly StatTile[] =>
  data.kind === 'episode' || data.kind === 'track'
    ? [
        {
          label: data.kind === 'episode' ? 'Episodes' : 'Tracks',
          value: formatCount(data.items),
          qualifier: 'distinct items played',
          icon: 'box',
        },
      ]
    : []

const tiles = ({ data, prose }: { data: TitleHistoryPage; prose: string }): readonly StatTile[] => [
  {
    label: 'Plays',
    value: formatCount(data.total),
    qualifier: `completed ${prose}`,
    icon: 'play',
  },
  {
    label: 'Viewers',
    value: formatCount(data.viewers),
    qualifier: 'accounts that finished it',
    icon: 'users',
  },
  {
    label: 'Rewatches',
    value: formatCount(data.rewatches),
    qualifier: 'finished again by the same viewer',
    icon: 'refresh',
  },
  ...itemsTile(data),
  {
    label: 'Last played',
    value: formatDate(data.last_viewed_at),
    qualifier: 'most recent completion',
    icon: 'history',
  },
]

/** One title's completed plays, newest first, a page at a time: who finished
    it, when, on which server and at what quality. */
export const TitleHistory = ({
  filters,
  titleKey,
  page,
  onPageChange,
  onBack,
  backLabel,
  onSelectViewer,
}: TitleHistoryProps) => {
  const history = useQuery({
    queryKey: titleHistoryKey({ key: titleKey, filters, page }),
    queryFn: () => fetchTitleHistory({ filters, titleKey, page, pageSize: PAGE_SIZE }),
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  })
  const prose = windowProse(filters.days)

  return (
    <AsyncSection
      id="plays-title-history"
      title="Title history"
      query={history}
      loadingLabel="Loading this title's history."
      errorSuffix="No history is available for this title."
      controls={
        <button className={styles.rowButton} type="button" onClick={onBack}>
          {backLabel}
        </button>
      }
    >
      {(data) => {
        const pageCount = Math.max(1, Math.ceil(data.total / data.page_size))
        const named = data.title.length > 0
        const scoped = scope(data)
        return (
          <div className={styles.wrap}>
            <p>
              <strong>
                {named ? titleWithYear({ title: data.title, year: data.year }) : UNKNOWN_TITLE}
              </strong>
              {scoped.length > 0 && <span className={styles.muted}>{`, ${scoped}`}</span>}
            </p>
            <StatTiles label="This title" tiles={tiles({ data, prose })} />
            {data.rows.length === 0 ? (
              <p className={styles.empty}>Nobody completed it {prose}.</p>
            ) : (
              <>
                <Pager page={page} pageCount={pageCount} onPageChange={onPageChange} />
                <div className={styles.scroller}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Viewer</th>
                        <th scope="col">Item</th>
                        <th scope="col">Quality</th>
                        <th scope="col">Server</th>
                        <th scope="col">Device</th>
                        <th scope="col">Library</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        // the ledger records one completion per item per
                        // second per server, and two viewers can finish the
                        // same item in the same second, so the account is
                        // part of what names a row
                        <tr
                          key={`${row.viewed_at}|${row.host}|${row.account_id}|${row.title}|${row.index ?? ''}`}
                        >
                          <td className={styles.nowrap}>{formatDateTime(row.viewed_at)}</td>
                          <td className={styles.primary}>
                            <button
                              className={styles.rowButton}
                              type="button"
                              onClick={() => onSelectViewer(row.account_id)}
                              aria-label={`${row.viewer}, view history`}
                            >
                              {row.viewer}
                            </button>
                          </td>
                          <td>{item(row)}</td>
                          <td>{row.kind === 'track' ? '--' : qualityLabel(row.quality)}</td>
                          <td>{row.host}</td>
                          <td>{row.device ?? '--'}</td>
                          <td>{row.library ?? '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} pageCount={pageCount} onPageChange={onPageChange} />
              </>
            )}
          </div>
        )
      }}
    </AsyncSection>
  )
}
