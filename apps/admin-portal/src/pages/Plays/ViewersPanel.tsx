import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fetchPlayUsers, windowProse, type PlaysFilters } from '@/lib/playsApi'
import { AsyncSection } from '@/pages/Plays/AsyncSection'
import { TAB_COPY } from '@/pages/Plays/playsCopy'
import { formatCount, formatDateTime, listHosts } from '@/pages/Plays/playsFormat'
import { REFETCH_MS, usersKey } from '@/pages/Plays/playsQueries'
import styles from '@/pages/Plays/DataTable.module.scss'

type ViewersPanelProps = {
  readonly filters: PlaysFilters
  readonly onSelect: (accountId: number) => void
}

/** Every account with a completed play in the window, most active first. */
export const ViewersPanel = ({ filters, onSelect }: ViewersPanelProps) => {
  const users = useQuery({
    queryKey: usersKey(filters),
    queryFn: () => fetchPlayUsers({ filters }),
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  })
  const copy = TAB_COPY.viewers

  return (
    <AsyncSection
      id="plays-viewers"
      title={copy.title}
      lede={copy.lede}
      query={users}
      loadingLabel="Loading viewers."
      errorSuffix={`No ${copy.reading} is available.`}
    >
      {(data) =>
        data.users.length === 0 ? (
          <p className={styles.empty}>No viewer completed a play {windowProse(filters.days)}.</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Viewer</th>
                  <th scope="col" className={styles.numeric}>
                    Plays
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Movies
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Episodes
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Tracks
                  </th>
                  <th scope="col">Servers</th>
                  <th scope="col">Last played</th>
                  <th scope="col">Most played</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.account_id}>
                    <td className={styles.primary}>
                      <button
                        className={styles.rowButton}
                        type="button"
                        onClick={() => onSelect(user.account_id)}
                        aria-label={`${user.name}, view history`}
                      >
                        {user.name}
                      </button>
                    </td>
                    <td className={styles.numeric}>{formatCount(user.plays)}</td>
                    <td className={styles.numeric}>{formatCount(user.movies)}</td>
                    <td className={styles.numeric}>{formatCount(user.episodes)}</td>
                    <td className={styles.numeric}>{formatCount(user.tracks)}</td>
                    <td>{listHosts(user.hosts)}</td>
                    <td className={styles.nowrap}>{formatDateTime(user.last_viewed_at)}</td>
                    <td>{user.top_title ?? '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </AsyncSection>
  )
}
