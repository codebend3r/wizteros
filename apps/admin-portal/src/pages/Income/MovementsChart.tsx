import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartLegend } from '@/components/Chart/ChartLegend'
import { CHART_MARGIN, COLLAPSED_CHART_HEIGHT } from '@/components/Chart/chartFrame'
import { ChartTooltip } from '@/components/Chart/ChartTooltip'
import { monthLabel, type IncomeMonth } from '@/lib/income'
import { useMeasuredWidth } from '@/lib/useMeasuredWidth'
import { moneyScale, signed } from '@/pages/Income/moneyScale'
import chrome from '@/components/Chart/chart.module.scss'
import styles from '@/pages/Income/chart.module.scss'

type MovementsChartProps = {
  readonly months: readonly IncomeMonth[]
}

/** One series per kind of movement, gains above the baseline and losses
    below it. The order is the stacking order, gains firmest at the bottom. */
const SERIES = [
  { key: 'signups', label: 'Signups', className: styles.gain },
  { key: 'upgrades', label: 'Upgrades', className: styles.gainSoft },
  { key: 'downgrades', label: 'Downgrades', className: styles.lossSoft },
  { key: 'churn', label: 'Cancellations', className: styles.loss },
] as const

type SeriesKey = (typeof SERIES)[number]['key']

// Room for "-$1,000" and its sign, set by hand: this chart sits at a known
// width, and a measured budget would only restate the number it already wears.
const MOVEMENTS_AXIS_PX = 60

type MovementRow = Record<SeriesKey, number> & { readonly month: string }

/** Losses drawn downward, so a month reads as what it gained against what it lost. */
const toRow = (month: IncomeMonth): MovementRow => ({
  month: month.month,
  signups: month.signups,
  upgrades: month.upgrades,
  downgrades: -month.downgrades,
  churn: -month.churn,
})

type TooltipProps = {
  readonly rows: readonly MovementRow[]
  readonly active?: boolean
  readonly label?: unknown
}

const MovementsTooltip = ({ rows, active, label }: TooltipProps) => {
  const row =
    typeof label === 'string' ? rows.find((candidate) => candidate.month === label) : undefined
  if (active !== true || row === undefined) return null
  const net = SERIES.reduce((sum, series) => sum + row[series.key], 0)
  return (
    <ChartTooltip
      title={monthLabel(row.month)}
      rows={SERIES.map((series) => ({
        key: series.key,
        value: signed(row[series.key]),
        name: series.label.toLowerCase(),
        swatchClass: series.className,
      }))}
      total={{ value: signed(net), name: 'net' }}
    />
  )
}

/** What each month gained and lost: signups and upgrades stacked up from the
    baseline, downgrades and cancellations stacked down from it. */
export const MovementsChart = ({ months }: MovementsChartProps) => {
  const { ref, width } = useMeasuredWidth()
  const rows = months.map(toRow)
  const reach = rows.reduce(
    (max, row) => Math.max(max, row.signups + row.upgrades, -(row.downgrades + row.churn)),
    0,
  )
  const scale = moneyScale({ peak: reach, mirrored: true, axisWidth: MOVEMENTS_AXIS_PX })

  if (months.length === 0) {
    return <p className={chrome.empty}>No months to show yet.</p>
  }

  return (
    <div className={chrome.chart}>
      <p className={chrome.caption}>
        Monthly income gained above the line and lost below it, by what moved it.
      </p>
      <div className={chrome.plotWrap} ref={ref}>
        <BarChart
          width={width}
          height={COLLAPSED_CHART_HEIGHT}
          data={rows}
          margin={CHART_MARGIN}
          stackOffset="sign"
          barCategoryGap="35%"
          maxBarSize={24}
          accessibilityLayer
          role="img"
          aria-label="Income gained and lost by month"
        >
          <CartesianGrid className={chrome.grid} vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={(value: string) => monthLabel(value)}
            tick={{ className: chrome.tickLabel }}
            tickLine={false}
            interval="preserveStartEnd"
            className={chrome.axis}
          />
          <YAxis
            type="number"
            domain={[scale.min, scale.max]}
            ticks={[...scale.ticks]}
            tickFormatter={scale.format}
            tick={{ className: chrome.tickLabel }}
            tickLine={false}
            axisLine={false}
            width={scale.axisWidth}
            className={chrome.axis}
          />
          <ReferenceLine y={0} className={styles.baseline} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ className: chrome.hoverBand }}
            content={<MovementsTooltip rows={rows} />}
          />
          {SERIES.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              name={series.label}
              stackId="movements"
              className={series.className}
              fill="var(--mark-color, currentColor)"
              // the surface-coloured stroke is the 2px gap between segments
              stroke="var(--color-surface)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </div>
      <ChartLegend
        items={SERIES.map((series) => ({
          key: series.key,
          name: series.label,
          swatchClass: series.className,
        }))}
      />
    </div>
  )
}
