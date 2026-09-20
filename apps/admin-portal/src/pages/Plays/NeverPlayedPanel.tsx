import { useState, type FormEvent } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fetchNeverPlayed, rangeProse, type PlaysFilters } from '@/lib/playsApi'
import { AsyncSection } from '@/components/AsyncSection/AsyncSection'
import { BreakdownList } from '@/pages/Plays/BreakdownList'
import { PagedTable } from '@/pages/Plays/Pager'
import { NEVER_KIND_LABEL, neverPlayedMeaning, TAB_COPY } from '@/pages/Plays/playsCopy'
import {
  formatCount,
  formatDate,
  pageCountOf,
  qualityLabel,
  titleWithYear,
} from '@/pages/Plays/playsFormat'
import { neverKey, PAGE_SIZE, REFETCH_MS } from '@/pages/Plays/playsQueries'
import { StatTiles } from '@/pages/Plays/StatTiles'
import tableStyles from '@/pages/Plays/DataTable.module.scss'
import styles from '@/pages/Plays/NeverPlayedPanel.module.scss'

type NeverPlayedPanelProps = {
  readonly filters: PlaysFilters
  /** The page being read, 1 based, and the term it is filtered by: both live
      in the url, so a refresh lands on the page and search that were open. */
  readonly page: number
  readonly onPageChange: (page: number) => void
  readonly search: string
  readonly onSearch: (search: string) => void
}

/** What is on the shelves with no completed play against it: movies by
    item, TV by show, audio by album, newest additions first. */
export const NeverPlayedPanel = ({
  filters,
  page,
  onPageChange,
  search: q,
  onSearch,
}: NeverPlayedPanelProps) => {
  // What is being typed is the box's own, not the page's: only a submitted
  // term becomes a url the refresh would come back to.
  const [draft, setDraft] = useState(q)

  const never = useQuery({
    queryKey: neverKey({ filters, page, q }),
    queryFn: () => fetchNeverPlayed({ filters, page, pageSize: PAGE_SIZE, q }),
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  })
  const copy = TAB_COPY.never
  const prose = rangeProse(filters.days)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSearch(draft.trim())
  }

  return (
    <AsyncSection
      id="plays-never"
      title={copy.title}
      lede={copy.lede}
      query={never}
      loadingLabel="Loading the never-played list."
      errorSuffix={`No ${copy.reading} is available.`}
      controls={
        <form className={styles.search} onSubmit={submit} role="search">
          <label className={styles.searchLabel} htmlFor="plays-never-search">
            Search titles
          </label>
          <input
            id="plays-never-search"
            className={styles.searchInput}
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="A title, a show, an album"
          />
          <button className={styles.searchButton} type="submit">
            Search
          </button>
        </form>
      }
    >
      {(data) => {
        const pageCount = pageCountOf({ total: data.total, pageSize: data.page_size })
        return (
          <div className={styles.panel}>
            <p className={styles.meaning}>{neverPlayedMeaning({ days: filters.days, prose })}</p>
            <StatTiles
              label="Never played, by kind"
              tiles={[
                { label: 'Movies', value: formatCount(data.summary.movies), icon: 'play' },
                { label: 'Shows', value: formatCount(data.summary.shows), icon: 'box' },
                { label: 'Albums', value: formatCount(data.summary.albums), icon: 'pulse' },
              ]}
            />
            <div className={styles.summaries}>
              <BreakdownList
                title="Movies by quality"
                note="Only movies have one resolution; a show or an album has many."
                rows={data.summary.by_quality.map((row) => ({
                  key: row.quality,
                  name: qualityLabel(row.quality),
                  value: row.count,
                }))}
                unit="never-played movies"
              />
              <BreakdownList
                title="By server"
                rows={data.summary.by_host.map((row) => ({
                  key: row.host,
                  name: row.host,
                  value: row.count,
                }))}
                unit="never-played titles"
              />
            </div>
            {data.rows.length === 0 ? (
              <p className={tableStyles.empty}>
                {q.length > 0
                  ? `Nothing never played matches "${q}".`
                  : 'Everything on the shelves has been played at least once.'}
              </p>
            ) : (
              <div className={tableStyles.wrap}>
                <PagedTable
                  page={page}
                  pageCount={pageCount}
                  onPageChange={onPageChange}
                  summary={`${formatCount(data.total)} titles`}
                >
                  <table className={tableStyles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Title</th>
                        <th scope="col">Type</th>
                        <th scope="col">Quality</th>
                        <th scope="col">Library</th>
                        <th scope="col">Server</th>
                        <th scope="col">Added</th>
                        <th scope="col" className={tableStyles.numeric}>
                          Items
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.key}>
                          <td className={tableStyles.primary}>
                            {titleWithYear({ title: row.title, year: row.year })}
                            {row.context !== null && (
                              <span className={tableStyles.secondary}>{row.context}</span>
                            )}
                          </td>
                          <td>{NEVER_KIND_LABEL[row.kind]}</td>
                          <td>{row.kind === 'movie' ? qualityLabel(row.quality) : '--'}</td>
                          <td>{row.library ?? '--'}</td>
                          <td>{row.host}</td>
                          {/* an item with no date was not "never" added, it
                            is one the server did not date */}
                          <td className={tableStyles.nowrap}>
                            {row.added_at === null ? 'unknown' : formatDate(row.added_at)}
                          </td>
                          <td className={tableStyles.numeric}>{formatCount(row.items)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </PagedTable>
              </div>
            )}
          </div>
        )
      }}
    </AsyncSection>
  )
}
