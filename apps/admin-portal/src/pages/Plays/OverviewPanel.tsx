import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fetchPlaysOverview, windowProse, type PlaysFilters } from '@/lib/playsApi'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { AsyncSection } from '@/components/AsyncSection/AsyncSection'
import { BreakdownList } from '@/pages/Plays/BreakdownList'
import { KIND_PLURAL, QUALITY_LABEL, TAB_COPY } from '@/pages/Plays/playsCopy'
import { formatCount, formatHours, titleWithYear } from '@/pages/Plays/playsFormat'
import { overviewKey, REFETCH_MS } from '@/pages/Plays/playsQueries'
import { PlaysTimeline } from '@/pages/Plays/PlaysTimeline'
import { StatTiles } from '@/pages/Plays/StatTiles'
import styles from '@/pages/Plays/OverviewPanel.module.scss'

type OverviewPanelProps = {
  readonly filters: PlaysFilters
  readonly onSelectViewer: (accountId: number) => void
  readonly onSelectTitle: (key: string) => void
  readonly onShowRanking: () => void
}

/** The summary view: the totals, the timeline, the three breakdowns, and a
    short list each of who and what led the window. */
export const OverviewPanel = ({
  filters,
  onSelectViewer,
  onSelectTitle,
  onShowRanking,
}: OverviewPanelProps) => {
  const overview = useQuery({
    queryKey: overviewKey(filters),
    queryFn: () => fetchPlaysOverview({ filters }),
    refetchInterval: REFETCH_MS,
    // a filter press repaints from the last answer while the new one loads,
    // rather than emptying every tile and chart for a moment
    placeholderData: keepPreviousData,
  })
  const copy = TAB_COPY.overview
  const prose = windowProse(filters.days)

  return (
    <AsyncSection
      id="plays-overview"
      title={copy.title}
      lede={copy.lede}
      query={overview}
      loadingLabel="Loading play history."
      errorSuffix={`No ${copy.reading} is available.`}
    >
      {(data) => (
        <div className={styles.overview}>
          <StatTiles
            label="Totals"
            tiles={[
              {
                label: 'Plays',
                value: formatCount(data.totals.plays),
                qualifier: `completed ${prose}`,
                icon: 'play',
              },
              {
                label: 'Viewers',
                value: formatCount(data.totals.viewers),
                qualifier: 'accounts with a play',
                icon: 'users',
              },
              {
                label: 'Titles',
                value: formatCount(data.totals.titles),
                qualifier: 'distinct items played',
                icon: 'box',
              },
              {
                label: 'Hours',
                value: formatHours(data.totals.watch_ms),
                qualifier: 'summed play durations',
                icon: 'history',
              },
            ]}
          />

          <PlaysTimeline timeline={data.timeline} hosts={data.by_host} days={filters.days} />

          <div className={styles.breakdowns}>
            <BreakdownList
              title="By type"
              rows={data.by_kind.map((row) => ({
                key: row.kind,
                name: KIND_PLURAL[row.kind],
                value: row.plays,
              }))}
              unit="plays"
            />
            <BreakdownList
              title="By quality"
              note="Video plays only. Audio has no resolution, so it is not counted here."
              rows={data.by_quality.map((row) => ({
                key: row.quality,
                name: QUALITY_LABEL[row.quality],
                value: row.plays,
              }))}
              unit="video plays"
            />
            <BreakdownList
              title="By server"
              rows={data.by_host.map((row, index) => ({
                key: row.host,
                name: row.host,
                value: row.plays,
                className: seriesClass(index),
              }))}
              unit="plays"
            />
          </div>

          <div className={styles.lists}>
            <section className={styles.list} aria-labelledby="plays-top-viewers">
              <h3 className={styles.listTitle} id="plays-top-viewers">
                Top viewers
              </h3>
              {data.top_viewers.length === 0 ? (
                <p className={styles.empty}>No viewer completed a play {prose}.</p>
              ) : (
                <ol className={styles.items}>
                  {data.top_viewers.map((viewer) => (
                    <li key={viewer.account_id} className={styles.item}>
                      <button
                        className={styles.itemButton}
                        type="button"
                        onClick={() => onSelectViewer(viewer.account_id)}
                      >
                        {viewer.name}
                      </button>
                      <span className={styles.itemFigure}>
                        {formatCount(viewer.plays)}
                        <span className={styles.itemUnit}> plays</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={styles.list} aria-labelledby="plays-top-titles">
              <h3 className={styles.listTitle} id="plays-top-titles">
                Most played
              </h3>
              {data.top_titles.length === 0 ? (
                <p className={styles.empty}>Nothing was completed {prose}.</p>
              ) : (
                <ol className={styles.items}>
                  {data.top_titles.map((title) => (
                    <li key={title.key} className={styles.item}>
                      <span className={styles.itemName}>
                        <button
                          className={styles.itemButton}
                          type="button"
                          onClick={() => onSelectTitle(title.key)}
                        >
                          {titleWithYear({ title: title.title, year: title.year })}
                        </button>
                        {title.context !== null && (
                          <span className={styles.itemContext}>{title.context}</span>
                        )}
                      </span>
                      <span className={styles.itemFigure}>
                        {formatCount(title.plays)}
                        <span className={styles.itemUnit}> plays</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {data.top_titles.length > 0 && (
                <button className={styles.more} type="button" onClick={onShowRanking}>
                  Show the full ranking
                </button>
              )}
            </section>
          </div>
        </div>
      )}
    </AsyncSection>
  )
}
