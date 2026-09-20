import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchTopTitles,
  windowProse,
  type PlaysFilters,
  type TopMetric,
  type TopTitle,
} from '@/lib/playsApi'
import { AsyncSection } from '@/components/AsyncSection/AsyncSection'
import { KIND_LABEL, TAB_COPY } from '@/pages/Plays/playsCopy'
import {
  formatCount,
  formatDateTime,
  listHosts,
  qualityLabel,
  titleWithYear,
} from '@/pages/Plays/playsFormat'
import { REFETCH_MS, TOP_LIMIT, topKey } from '@/pages/Plays/playsQueries'
import styles from '@/pages/Plays/DataTable.module.scss'

type TopTitlesPanelProps = {
  readonly filters: PlaysFilters
  readonly metric: TopMetric
  readonly onSelectTitle: (key: string) => void
}

/** What scopes a ranked title: the artist for an album, and how many distinct
    episodes or tracks the plays were spread over. */
const context = (title: TopTitle): string => {
  const parts = [
    title.context ?? '',
    title.kind === 'episode' && title.items > 0
      ? `${formatCount(title.items)} ${title.items === 1 ? 'episode' : 'episodes'} played`
      : '',
    title.kind === 'track' && title.items > 0
      ? `${formatCount(title.items)} ${title.items === 1 ? 'track' : 'tracks'} played`
      : '',
  ]
  return parts.filter((part) => part.length > 0).join(', ')
}

/** Titles ranked by completed plays or by rewatches, one table for both. */
export const TopTitlesPanel = ({ filters, metric, onSelectTitle }: TopTitlesPanelProps) => {
  const titles = useQuery({
    queryKey: topKey({ metric, filters }),
    queryFn: () => fetchTopTitles({ filters, metric, limit: TOP_LIMIT }),
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  })
  const copy = metric === 'plays' ? TAB_COPY.top : TAB_COPY.rewatched
  const prose = windowProse(filters.days)

  return (
    <AsyncSection
      id={`plays-top-${metric}`}
      title={copy.title}
      lede={copy.lede}
      query={titles}
      loadingLabel={`Loading the ${copy.reading}.`}
      errorSuffix={`No ${copy.reading} is available.`}
    >
      {(data) =>
        data.titles.length === 0 ? (
          <p className={styles.empty}>
            {metric === 'plays'
              ? `Nothing was completed ${prose}.`
              : `Nothing was completed twice by the same viewer ${prose}.`}
          </p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" className={styles.rank}>
                    #
                  </th>
                  <th scope="col">Title</th>
                  <th scope="col">Type</th>
                  <th scope="col">Quality</th>
                  <th scope="col" className={styles.numeric}>
                    Plays
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Viewers
                  </th>
                  <th scope="col" className={styles.numeric}>
                    Rewatches
                  </th>
                  <th scope="col">Last played</th>
                  <th scope="col">Servers</th>
                </tr>
              </thead>
              <tbody>
                {data.titles.map((title, index) => {
                  const scope = context(title)
                  const name = titleWithYear({ title: title.title, year: title.year })
                  return (
                    <tr key={title.key}>
                      <td className={styles.rank}>{index + 1}</td>
                      <td className={styles.primary}>
                        <button
                          className={styles.rowButton}
                          type="button"
                          onClick={() => onSelectTitle(title.key)}
                          aria-label={`${name}, view play history`}
                        >
                          {name}
                        </button>
                        {scope.length > 0 && <span className={styles.secondary}>{scope}</span>}
                      </td>
                      <td>{KIND_LABEL[title.kind]}</td>
                      <td>{title.kind === 'track' ? '--' : qualityLabel(title.quality)}</td>
                      <td className={styles.numeric}>{formatCount(title.plays)}</td>
                      <td className={styles.numeric}>{formatCount(title.viewers)}</td>
                      <td className={styles.numeric}>
                        {formatCount(title.rewatches)}
                        {title.top_rewatcher !== null && title.rewatches > 0 && (
                          <span className={styles.secondary}>
                            {`most by ${title.top_rewatcher.name}, ${formatCount(title.top_rewatcher.plays)} plays`}
                          </span>
                        )}
                      </td>
                      <td className={styles.nowrap}>{formatDateTime(title.last_viewed_at)}</td>
                      <td>{listHosts(title.hosts)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      }
    </AsyncSection>
  )
}
