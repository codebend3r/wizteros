import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMoney, monthLabel, type IncomeMonth } from '@/lib/income'
import { useMeasuredWidth } from '@/lib/useMeasuredWidth'
import { CHART_HEIGHT, niceCeiling, quarterTicks } from '@/pages/Income/chartFrame'
import styles from '@/pages/Income/chart.module.scss'

type MovementsChartProps = {
  readonly months: readonly IncomeMonth[]
}

const MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const

/** One series per kind of movement, gains above the baseline and losses
    below it. The order is the stacking order, gains firmest at the bottom. */
const SERIES = [
  { key: 'signups', label: 'Signups', className: styles.gain },
  { key: 'upgrades', label: 'Upgrades', className: styles.gainSoft },
  { key: 'downgrades', label: 'Downgrades', className: styles.lossSoft },
  { key: 'churn', label: 'Cancellations', className: styles.loss },
] as const

type SeriesKey = (typeof SERIES)[number]['key']

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

const signed = (value: number): string =>
  value === 0 ? formatMoney(0) : `${value > 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`

const MovementsTooltip = ({ rows, active, label }: TooltipProps) => {
  const row =
    typeof label === 'string' ? rows.find((candidate) => candidate.month === label) : undefined
  if (active !== true || row === undefined) return null
  const net = SERIES.reduce((sum, series) => sum + row[series.key], 0)
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{monthLabel(row.month)}</p>
      <ul className={styles.tooltipRows}>
        {SERIES.map((series) => (
          <li key={series.key} className={styles.tooltipRow}>
            <span className={`${styles.swatch} ${series.className}`} aria-hidden="true" />
            <span className={styles.tooltipValue}>{signed(row[series.key])}</span>
            <span className={styles.tooltipName}>{series.label.toLowerCase()}</span>
          </li>
        ))}
        <li className={styles.tooltipRow}>
          <span className={styles.swatchGap} aria-hidden="true" />
          <span className={styles.tooltipValue}>{signed(net)}</span>
          <span className={styles.tooltipName}>net</span>
        </li>
      </ul>
    </div>
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
  const ceiling = niceCeiling(reach)

  if (months.length === 0) {
    return <p className={styles.empty}>No months to show yet.</p>
  }

  return (
    <div className={styles.chart}>
      <p className={styles.caption}>
        Monthly income gained above the line and lost below it, by what moved it.
      </p>
      <div className={styles.plotWrap} ref={ref}>
        <BarChart
          width={width}
          height={CHART_HEIGHT}
          data={rows}
          margin={MARGIN}
          stackOffset="sign"
          barCategoryGap="35%"
          maxBarSize={24}
          accessibilityLayer
          role="img"
          aria-label="Income gained and lost by month"
        >
          <CartesianGrid className={styles.grid} vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={(value: string) => monthLabel(value)}
            tick={{ className: styles.tickLabel }}
            tickLine={false}
            interval="preserveStartEnd"
            className={styles.axis}
          />
          <YAxis
            type="number"
            domain={[-ceiling, ceiling]}
            ticks={[...quarterTicks({ ceiling, mirrored: true })]}
            tickFormatter={(value: number) => signed(value)}
            tick={{ className: styles.tickLabel }}
            tickLine={false}
            axisLine={false}
            width={60}
            className={styles.axis}
          />
          <ReferenceLine y={0} className={styles.baseline} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ className: styles.hoverBand }}
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
      <ul className={styles.legend}>
        {SERIES.map((series) => (
          <li key={series.key} className={styles.legendItem}>
            <span className={`${styles.swatch} ${series.className}`} aria-hidden="true" />
            <span>{series.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
