import type { UseQueryResult } from '@tanstack/react-query'
import { windowProse, type PlayHistory } from '@/lib/playsApi'
import { errorMessage } from '@/components/AsyncSection/AsyncSection'
import { PagedTable } from '@/pages/Plays/Pager'
import {
  formatCount,
  formatDateTime,
  pageCountOf,
  playSubject,
  qualityLabel,
} from '@/pages/Plays/playsFormat'
import { KindTag, ServerTag } from '@/pages/Plays/Tags'
import sectionStyles from '@/components/AsyncSection/AsyncSection.module.scss'
import tableStyles from '@/pages/Plays/DataTable.module.scss'
import styles from '@/pages/Plays/WatchHistory.module.scss'

type WatchHistoryProps = {
  /** Read beside the overview rather than inside it, so the two load
      together and a page turn repaints this table alone. */
  readonly query: UseQueryResult<PlayHistory>
  /** Every Plex host in config order, the order the chart colours them by,
      so a server's pill here wears the colour of its bars above. */
  readonly hosts: readonly string[]
  readonly days: number
  /** The page being read, 1 based, from the url like every other table's. */
  readonly page: number
  readonly onPageChange: (page: number) => void
  readonly onSelectViewer: (accountId: number) => void
  readonly onSelectTitle: (key: string) => void
}

/** Every completed play in the window, newest first, a page at a time: who
    finished what, when, on which server and on what device.
 *
 * It carries its own loading and failed states rather than the overview's,
 * so a history the monitor cannot answer leaves the totals and the chart
 * above it standing.
 */
export const WatchHistory = ({
  query,
  hosts,
  days,
  page,
  onPageChange,
  onSelectViewer,
  onSelectTitle,
}: WatchHistoryProps) => {
  const prose = windowProse(days)
  return (
    <section className={styles.history} aria-labelledby="plays-watch-history">
      <h3 className={styles.title} id="plays-watch-history">
        Watch history
      </h3>
      {!!query.isPending && (
        <p className={sectionStyles.muted} aria-live="polite">
          Loading the watch history.
        </p>
      )}
      {!!query.isError && (
        <p className={sectionStyles.alert} role="alert">
          {`${errorMessage({ error: query.error })} No watch history is available.`}
        </p>
      )}
      {!!query.data &&
        (query.data.total === 0 ? (
          <p className={tableStyles.empty}>Nothing completed {prose}.</p>
        ) : (
          <PagedTable
            page={page}
            pageCount={pageCountOf({ total: query.data.total, pageSize: query.data.page_size })}
            onPageChange={onPageChange}
            summary={`${formatCount(query.data.total)} completed plays ${prose}`}
          >
            <table className={tableStyles.table}>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Viewer</th>
                  <th scope="col">Title</th>
                  <th scope="col">Type</th>
                  <th scope="col">Quality</th>
                  <th scope="col">Server</th>
                  <th scope="col">Device</th>
                  <th scope="col">Library</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((row) => {
                  const { primary, secondary } = playSubject(row)
                  return (
                    <tr
                      key={`${row.viewed_at}|${row.host}|${row.account_id}|${row.group_key}|${row.title}|${row.parent_index ?? ''}|${row.index ?? ''}`}
                    >
                      <td className={tableStyles.nowrap}>{formatDateTime(row.viewed_at)}</td>
                      <td>
                        <button
                          className={tableStyles.rowButton}
                          type="button"
                          onClick={() => onSelectViewer(row.account_id)}
                          aria-label={`${row.viewer}, view history`}
                        >
                          {row.viewer}
                        </button>
                      </td>
                      <td className={tableStyles.primary}>
                        <button
                          className={tableStyles.titleButton}
                          type="button"
                          onClick={() => onSelectTitle(row.group_key)}
                          aria-label={`${primary}, view play history`}
                        >
                          {primary}
                        </button>
                        {secondary.length > 0 && (
                          <span className={tableStyles.secondary}>{secondary}</span>
                        )}
                      </td>
                      <td>
                        <KindTag kind={row.kind} />
                      </td>
                      <td>{row.kind === 'track' ? '--' : qualityLabel(row.quality)}</td>
                      <td>
                        <ServerTag host={row.host} hosts={hosts} />
                      </td>
                      <td>{row.device ?? '--'}</td>
                      <td>{row.library ?? '--'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </PagedTable>
        ))}
    </section>
  )
}
