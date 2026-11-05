import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartLegend } from '@/components/Chart/ChartLegend'
import { CHART_MARGIN } from '@/components/Chart/chartFrame'
import { ChartTooltip } from '@/components/Chart/ChartTooltip'
import { labelAxisWidth, quarterTicks } from '@/components/Chart/chartScale'
import { formatBytes, type FleetHost } from '@/lib/fleetApi'
import { useMeasuredBox } from '@/components/Chart/useMeasuredBox'
import { niceCeiling } from '@/pages/Fleet/metricScale'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import chrome from '@/components/Chart/chart.module.scss'
import styles from '@/pages/Fleet/StorageChart.module.scss'

type StorageChartProps = {
  readonly hosts: readonly FleetHost[]
}

/** One host's volume, in bytes, as the bars draw it. */
type StorageRow = {
  readonly name: string
  /** The host's place in fleet order, which is what picks its colour. */
  readonly seriesIndex: number
  readonly used: number
  readonly free: number
  readonly total: number
  /** Used space as a whole percent of the volume, printed at the bar's end. */
  readonly usedLabel: string
}

// Every bar the same thickness, and room around it for the next host's name.
const BAR_PX = 22
const ROW_PX = 44
// The x axis under the bars, plus the chart margin's top and bottom.
const AXIS_PX = 40

// Room after the longest bar for its "100% used" label, which a bar that runs
// to the axis ceiling would otherwise push off the plot.
const STORAGE_MARGIN = { ...CHART_MARGIN, right: 80 } as const

// Below this the plot cannot fit five byte labels side by side.
const NARROW_PX = 480

/** A byte figure on the axis. Zero is "0", as on the rate axis: an origin needs
    no unit, and "0.0 B" crowds the first label. */
const formatAxisBytes = (value: number): string => (value === 0 ? '0' : formatBytes(value))

/** Used over total, from the same two gauges the free-space chart reads, so the
    bar and the line can never disagree about how full a volume is. */
const usedPercent = ({ used, total }: { used: number; total: number }): number =>
  Math.round((used / total) * 100)

/** A host's volume as a bar, or null for a host whose disk was never read or
    came back unreadable: no bar at all, rather than an empty one claiming a
    volume of nothing. */
const toRow = ({ host, index }: { host: FleetHost; index: number }): StorageRow | null => {
  const total = host.disk_total_bytes
  const free = host.disk_available_bytes
  if (total === null || free === null || !(total > 0) || free < 0 || free > total) return null
  const used = total - free
  return {
    name: host.name,
    seriesIndex: index,
    used,
    free,
    total,
    usedLabel: `${usedPercent({ used, total })}% used`,
  }
}

type StorageTooltipProps = {
  readonly rows: readonly StorageRow[]
  /** Injected by Recharts when it clones this element. */
  readonly active?: boolean
  readonly label?: unknown
}

const StorageTooltip = ({ rows, active, label }: StorageTooltipProps) => {
  const row =
    typeof label === 'string' ? rows.find((candidate) => candidate.name === label) : undefined
  if (active !== true || row === undefined) return null
  return (
    <ChartTooltip
      title={row.name}
      rows={[
        {
          key: 'used',
          value: formatBytes(row.used),
          name: `used (${usedPercent(row)}%)`,
          swatchClass: seriesClass(row.seriesIndex),
        },
        { key: 'free', value: formatBytes(row.free), name: 'free', swatchClass: styles.free },
      ]}
      total={{ value: formatBytes(row.total), name: 'volume size' }}
    />
  )
}

/** Every host's watched volume side by side, drawn to one scale.
 *
 * A bar's whole length is the volume's size and its coloured part is what is
 * used, so the chart answers two questions at once: which box is fullest, from
 * the share each bar has filled, and where the room actually is, from how long
 * each bar is. A percentage alone would rank a nearly full 4 TB box beside a
 * nearly full 60 TB one as if they held the same.
 *
 * Read from `/fleet`, the query the host cards already poll, so the chart costs
 * no request of its own.
 */
export const StorageChart = ({ hosts }: StorageChartProps) => {
  const { ref, width } = useMeasuredBox()
  const read = hosts.map((host, index) => ({ host, row: toRow({ host, index }) }))
  const rows = read.flatMap(({ row }) => (row === null ? [] : [row]))
  const unread = read.flatMap(({ host, row }) => (row === null ? [host] : []))

  if (rows.length === 0) {
    return (
      <p className={chrome.empty}>
        No host has reported a disk reading yet. The bars fill in after the collector's next disk
        tick.
      </p>
    )
  }

  const max = niceCeiling(Math.max(...rows.map((row) => row.total)))
  // "100.0 TB" is wide: quarters on a phone run each label into the next, so a
  // narrow box marks halves instead
  const ticks = width < NARROW_PX ? [0, max / 2, max] : quarterTicks({ ceiling: max })
  const nameWidth = labelAxisWidth(rows.map((row) => row.name))

  return (
    <div className={chrome.chart}>
      <p className={chrome.caption}>
        {`Each host's ${hosts[0]?.disk_mount ?? 'watched volume'} drawn to one scale: a bar's length is the volume's size, its coloured part the space used and the rest the space free.`}
      </p>
      <div className={chrome.plotWrap} ref={ref}>
        <BarChart
          width={width}
          height={rows.length * ROW_PX + AXIS_PX}
          data={rows}
          layout="vertical"
          margin={STORAGE_MARGIN}
          barSize={BAR_PX}
          accessibilityLayer
          role="img"
          aria-label="Disk space used and free by host"
        >
          <CartesianGrid className={chrome.grid} horizontal={false} />
          <XAxis
            type="number"
            domain={[0, max]}
            ticks={[...ticks]}
            tickFormatter={formatAxisBytes}
            tick={{ className: chrome.tickLabel }}
            tickLine={false}
            interval={0}
            className={chrome.axis}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={nameWidth}
            tick={{ className: chrome.tickLabel }}
            tickLine={false}
            axisLine={false}
            className={chrome.axis}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ className: chrome.hoverBand }}
            content={<StorageTooltip rows={rows} />}
          />
          <Bar
            dataKey="used"
            name="Used"
            stackId="volume"
            // each host's used share wears that host's colour, the one its
            // card and its lines on the charts above wear
            fill="var(--series-color, currentColor)"
            // the surface-coloured stroke is the gap between used and free
            stroke="var(--color-surface)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {rows.map((row) => (
              <Cell key={row.name} className={seriesClass(row.seriesIndex)} />
            ))}
          </Bar>
          <Bar
            dataKey="free"
            name="Free"
            stackId="volume"
            className={styles.free}
            fill="var(--mark-color, currentColor)"
            stroke="var(--color-surface)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {/* the share in words at the end of each bar, so how full a box is
              never rests on reading the colour split */}
            <LabelList dataKey="usedLabel" position="right" className={styles.barLabel} />
          </Bar>
        </BarChart>
      </div>
      <ChartLegend
        items={[
          ...rows.map((row) => ({
            key: row.name,
            name: row.name,
            swatchClass: seriesClass(row.seriesIndex),
            note: `${formatBytes(row.used)} of ${formatBytes(row.total)} used, ${formatBytes(row.free)} free`,
          })),
          { key: 'free', name: 'Free space', swatchClass: styles.free },
          ...unread.map((host) => ({ key: host.name, name: host.name, note: 'no disk reading' })),
        ]}
      />
    </div>
  )
}
