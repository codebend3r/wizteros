import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMoney, monthLabel, type IncomeMonth } from '@/lib/income'
import { useMeasuredWidth } from '@/lib/useMeasuredWidth'
import { CHART_HEIGHT, niceCeiling, quarterTicks } from '@/pages/Income/chartFrame'
import styles from '@/pages/Income/chart.module.scss'

type GrowthChartProps = {
  readonly months: readonly IncomeMonth[]
}

const MARGIN = { top: 20, right: 28, bottom: 4, left: 0 } as const

// Room under the axis for a second line when any month carries an outage.
const AXIS_HEIGHT = 30
const AXIS_HEIGHT_WITH_NOTE = 46

type TickProps = {
  readonly x?: number | string
  readonly y?: number | string
  readonly payload?: { readonly value?: unknown }
}

/** A month's tick: its name, and under it how many outages it saw, if any.
    Written as text so the incident is read, never inferred from a glyph. */
const monthTick =
  (months: readonly IncomeMonth[]) =>
  ({ x, y, payload }: TickProps) => {
    const value = payload?.value ?? ''
    const month = typeof value === 'string' ? value : ''
    const outages = months.find((row) => row.month === month)?.outages ?? 0
    return (
      <g transform={`translate(${Number(x ?? 0)},${Number(y ?? 0)})`}>
        <text className={styles.tickLabel} textAnchor="middle" dy={12}>
          {monthLabel(month)}
        </text>
        {outages > 0 && (
          <text className={styles.tickNote} textAnchor="middle" dy={28}>
            {outages} outage{outages === 1 ? '' : 's'}
          </text>
        )}
      </g>
    )
  }

type LabelProps = {
  readonly x?: number | string
  readonly y?: number | string
  readonly value?: unknown
  readonly index?: number
}

/** The figure at the line's tip, and nowhere else: one direct label, where
    the eye lands, with the axis carrying the rest. */
const endLabel =
  (last: number) =>
  ({ x, y, value, index }: LabelProps) =>
    index === last &&
    typeof value === 'number' && (
      <text
        className={styles.endLabel}
        x={Number(x ?? 0)}
        y={Number(y ?? 0) - 12}
        textAnchor={last === 0 ? 'middle' : 'end'}
      >
        {formatMoney(value)}
      </text>
    )

type TooltipProps = {
  readonly months: readonly IncomeMonth[]
  readonly active?: boolean
  readonly label?: unknown
}

const GrowthTooltip = ({ months, active, label }: TooltipProps) => {
  const row = typeof label === 'string' ? months.find((month) => month.month === label) : undefined
  if (active !== true || row === undefined) return null
  const lines = [
    { name: 'income', value: formatMoney(row.income) },
    { name: 'paying members', value: String(row.members) },
    ...(row.signups > 0 ? [{ name: 'from signups', value: `+${formatMoney(row.signups)}` }] : []),
    ...(row.upgrades > 0
      ? [{ name: 'from upgrades', value: `+${formatMoney(row.upgrades)}` }]
      : []),
    ...(row.downgrades > 0
      ? [{ name: 'to downgrades', value: `-${formatMoney(row.downgrades)}` }]
      : []),
    ...(row.churn > 0 ? [{ name: 'to cancellations', value: `-${formatMoney(row.churn)}` }] : []),
    ...(row.outages > 0 ? [{ name: 'outages', value: String(row.outages) }] : []),
    ...(row.paymentFailures > 0
      ? [{ name: 'payments failed', value: String(row.paymentFailures) }]
      : []),
  ]
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{monthLabel(row.month)}</p>
      <ul className={styles.tooltipRows}>
        {lines.map((line) => (
          <li key={line.name} className={styles.tooltipRow}>
            <span className={styles.tooltipValue}>{line.value}</span>
            <span className={styles.tooltipName}>{line.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Monthly income, month by month, as one line with a wash under it. */
export const GrowthChart = ({ months }: GrowthChartProps) => {
  const { ref, width } = useMeasuredWidth()
  const noted = months.some((row) => row.outages > 0)
  const ceiling = niceCeiling(months.reduce((max, row) => Math.max(max, row.income), 0))

  if (months.length === 0) {
    return <p className={styles.empty}>No months to show yet.</p>
  }

  return (
    <div className={styles.chart}>
      <p className={styles.caption}>
        Income at the end of each month, from the first signup on record to today. Months with
        outages say so under the axis.
      </p>
      <div className={styles.plotWrap} ref={ref}>
        <ComposedChart
          width={width}
          height={CHART_HEIGHT + (noted ? AXIS_HEIGHT_WITH_NOTE - AXIS_HEIGHT : 0)}
          data={[...months]}
          margin={MARGIN}
          accessibilityLayer
          role="img"
          aria-label="Monthly income by month"
          className={styles.income}
        >
          <CartesianGrid className={styles.grid} vertical={false} />
          <XAxis
            dataKey="month"
            tick={monthTick(months)}
            tickLine={false}
            height={noted ? AXIS_HEIGHT_WITH_NOTE : AXIS_HEIGHT}
            interval="preserveStartEnd"
            className={styles.axis}
          />
          <YAxis
            type="number"
            domain={[0, ceiling]}
            ticks={[...quarterTicks({ ceiling })]}
            tickFormatter={(value: number) => formatMoney(value)}
            tick={{ className: styles.tickLabel }}
            tickLine={false}
            axisLine={false}
            width={56}
            className={styles.axis}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ className: styles.crosshair }}
            content={<GrowthTooltip months={months} />}
          />
          <Area
            type="monotone"
            dataKey="income"
            stroke="none"
            fill="var(--mark-color, currentColor)"
            fillOpacity={0.1}
            isAnimationActive={false}
            // the line below carries the tooltip; a second entry per month
            // would say the same number twice
            tooltipType="none"
          />
          <Line
            type="monotone"
            dataKey="income"
            name="income"
            stroke="var(--mark-color, currentColor)"
            strokeWidth={2}
            // a lone month has no line to draw, so it wears a dot instead
            dot={months.length <= 2}
            activeDot={{
              r: 4,
              fill: 'var(--mark-color, currentColor)',
              stroke: 'var(--color-surface)',
              strokeWidth: 2,
            }}
            label={endLabel(months.length - 1)}
            isAnimationActive={false}
          />
        </ComposedChart>
      </div>
    </div>
  )
}
