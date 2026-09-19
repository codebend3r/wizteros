import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchViewerHistory,
  windowProse,
  type PlaysFilters,
  type ViewerHistoryRow,
} from '@/lib/playsApi'
import { AsyncSection } from '@/pages/Plays/AsyncSection'
import { Pager } from '@/pages/Plays/Pager'
import { KIND_LABEL } from '@/pages/Plays/playsCopy'
import {
  episodeLabel,
  formatCount,
  formatDateTime,
  qualityLabel,
  titleWithYear,
} from '@/pages/Plays/playsFormat'
import { PAGE_SIZE, REFETCH_MS, viewerKey } from '@/pages/Plays/playsQueries'
import styles from '@/pages/Plays/DataTable.module.scss'

type ViewerHistoryProps = {
  readonly filters: PlaysFilters
  readonly accountId: number
  /** The page being read, 1 based. It lives in the url beside the viewer, so
      a refresh comes back to the same page of the same history. */
  readonly page: number
  readonly onPageChange: (page: number) => void
  readonly onBack: () => void
  readonly onSelectTitle: (key: string) => void
}

/** The row's subject and what scopes it: the show over the episode, the
    artist and album over the track, the year beside a film. */
const subject = (row: ViewerHistoryRow): { primary: string; secondary: string } => {
  if (row.kind === 'episode') {
    const code = episodeLabel({ parentIndex: row.parent_index, index: row.index })
    return {
      primary: row.grandparent_title ?? row.title,
      secondary: [code, row.title].filter((part) => part.length > 0).join(' '),
    }
  }
  if (row.kind === 'track') {
    return {
      primary: row.title,
      secondary: [row.grandparent_title, row.parent_title]
        .flatMap((part) => (part === null ? [] : [part]))
        .join(', '),
    }
  }
  return { primary: titleWithYear({ title: row.title, year: row.year }), secondary: '' }
}

const kindLabel = (kind: string): string =>
  kind === 'movie' || kind === 'episode' || kind === 'track' ? KIND_LABEL[kind] : kind

/** One viewer's completed plays, newest first, a page at a time. */
export const ViewerHistory = ({
  filters,
  accountId,
  page,
  onPageChange,
  onBack,
  onSelectTitle,
}: ViewerHistoryProps) => {
  const history = useQuery({
    queryKey: viewerKey({ accountId, filters, page }),
    queryFn: () => fetchViewerHistory({ filters, accountId, page, pageSize: PAGE_SIZE }),
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  })

  return (
    <AsyncSection
      id="plays-viewer-history"
      title="Viewer history"
      query={history}
      loadingLabel="Loading this viewer's history."
      errorSuffix="No history is available for this viewer."
      controls={
        <button className={styles.rowButton} type="button" onClick={onBack}>
          Back to viewers
        </button>
      }
    >
      {(data) => {
        const pageCount = Math.max(1, Math.ceil(data.total / data.page_size))
        const summary = `${formatCount(data.total)} completed plays ${windowProse(filters.days)}`
        return (
          <div className={styles.wrap}>
            <p>
              <strong>{data.name}</strong>
              <span className={styles.muted}>{`, ${summary}.`}</span>
            </p>
            {data.rows.length === 0 ? (
              <p className={styles.empty}>Nothing completed {windowProse(filters.days)}.</p>
            ) : (
              <>
                <Pager page={page} pageCount={pageCount} onPageChange={onPageChange} />
                <div className={styles.scroller}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Title</th>
                        <th scope="col">Type</th>
                        <th scope="col">Quality</th>
                        <th scope="col">Server</th>
                        <th scope="col">Device</th>
                        <th scope="col">Library</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => {
                        const { primary, secondary } = subject(row)
                        return (
                          // the ledger records one completion per item per
                          // second per server, so this names a row uniquely
                          <tr
                            key={`${row.viewed_at}|${row.host}|${row.kind}|${row.title}|${secondary}`}
                          >
                            <td className={styles.nowrap}>{formatDateTime(row.viewed_at)}</td>
                            <td className={styles.primary}>
                              <button
                                className={styles.rowButton}
                                type="button"
                                onClick={() => onSelectTitle(row.group_key)}
                                aria-label={`${primary}, view play history`}
                              >
                                {primary}
                              </button>
                              {secondary.length > 0 && (
                                <span className={styles.secondary}>{secondary}</span>
                              )}
                            </td>
                            <td>{kindLabel(row.kind)}</td>
                            <td>{row.kind === 'track' ? '--' : qualityLabel(row.quality)}</td>
                            <td>{row.host}</td>
                            <td>{row.device ?? '--'}</td>
                            <td>{row.library ?? '--'}</td>
                          </tr>
                        )
                      })}
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
