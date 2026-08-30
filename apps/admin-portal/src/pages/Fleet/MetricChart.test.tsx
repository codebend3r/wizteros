import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import type { MetricHostSeries } from '@/lib/fleetApi'
import { METRIC_COPY } from '@/pages/Fleet/metricCopy'
import { MetricChart } from '@/pages/Fleet/MetricChart'

const T0 = Date.parse('2026-08-23T12:00:00+00:00')

const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString()

const series = ({
  name,
  points,
}: {
  name: string
  points: readonly (readonly [number, number])[]
}): MetricHostSeries => ({
  name,
  points: points.map(([offset, value]) => ({ at: at(offset), value })),
})

const meleys = series({
  name: 'meleys',
  points: [
    [0, 20],
    [30, 25],
    [60, 30],
  ],
})

const vermithor = series({
  name: 'vermithor',
  points: [
    [0, 50],
    [30, 55],
  ],
})

// A fixed present, injected so the sliding window is deterministic: the frame
// is [NOW - 60min, NOW] and every fixture point sits inside it.
const NOW = T0 + 390_000

// One sampling tick plus slack, for the cases that assert nothing was added.
const SAMPLE_WAIT_MS = 1400

const renderChart = (chartHosts: readonly MetricHostSeries[]) =>
  render(
    <MetricChart
      hosts={chartHosts}
      windowMinutes={60}
      unit="percent"
      copy={METRIC_COPY.cpu}
      now={() => NOW}
    />,
  )

/** The `d` of each drawn line. Recharts emits one path per series, with a
    fresh `M` wherever a null broke it, so segments are counted inside a path
    rather than by counting paths. */
const curves = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll('path.recharts-curve')].map((path) => path.getAttribute('d') ?? '')

const segments = (d: string): number => (d.match(/M/g) ?? []).length

test('MetricChart legend names every host, including one with nothing to draw', () => {
  renderChart([meleys, series({ name: 'caraxes', points: [] })])

  const legend = screen.getByRole('list')
  expect(within(legend).getByText('meleys')).toBeInTheDocument()
  expect(within(legend).getByText('caraxes')).toBeInTheDocument()
  // absent is absent: a host that reported nothing says so instead of drawing
  // a flat line at zero
  expect(within(legend).getByText('no readings')).toBeInTheDocument()
})

test('MetricChart says so when no host reported at all', () => {
  renderChart([series({ name: 'meleys', points: [] })])

  expect(screen.getByText(/No CPU readings in the last hour/)).toBeInTheDocument()
})

test('MetricChart draws one line per host in its own series class', () => {
  const { container } = renderChart([meleys, vermithor])

  const lines = [...container.querySelectorAll('.recharts-line')]
  expect(lines).toHaveLength(2)
  expect(lines[0]).toHaveClass('series1')
  expect(lines[1]).toHaveClass('series2')
})

test('MetricChart curves between readings rather than joining them straight', () => {
  const { container } = renderChart([
    series({
      name: 'meleys',
      points: [
        [0, 20],
        [30, 25],
        [60, 45],
        [90, 30],
        [120, 60],
      ],
    }),
  ])

  const [drawn = ''] = curves(container)
  expect(drawn).toContain('C')
  expect(drawn).not.toContain('L')
})

test('MetricChart breaks a line across a gap instead of bridging it', () => {
  // readings every 30s, then a five-minute hole: drawing through it would
  // claim the host was observed while it was not
  const gappy = series({
    name: 'meleys',
    points: [
      [0, 20],
      [30, 25],
      [330, 40],
      [360, 45],
    ],
  })
  const { container } = renderChart([gappy])

  const [drawn = ''] = curves(container)
  expect(segments(drawn)).toBe(2)
})

test('MetricChart says nothing about freshness while the readings keep coming', () => {
  render(
    <MetricChart
      hosts={[meleys]}
      windowMinutes={60}
      unit="percent"
      copy={METRIC_COPY.cpu}
      now={() => T0 + 90_500}
    />,
  )

  // the newest reading sits at T0+60s against a 30s cadence, so 30.5s of age is
  // the ordinary lag between a reading and the frame that drew it, not news
  expect(screen.queryByText(/Newest reading/)).toBeNull()
})

test('MetricChart carries the newest reading forward a point per second', async () => {
  // a present 10s past the last reading, well inside the 30s cadence, so the
  // value is held rather than dropped as stale
  let offset = 0
  const { container } = render(
    <MetricChart
      hosts={[meleys]}
      windowMinutes={60}
      unit="percent"
      copy={METRIC_COPY.cpu}
      now={() => T0 + 70_000 + offset}
    />,
  )

  const curveCount = (): number => ((curves(container)[0] ?? '').match(/C/g) ?? []).length
  const before = curveCount()

  // the trail advances on its own timer, not on a refetch: nothing about this
  // render changes except the clock
  offset = 1000
  await waitFor(() => expect(curveCount()).toBeGreaterThan(before), { timeout: 4000 })
  const afterOne = curveCount()
  offset = 2000
  await waitFor(() => expect(curveCount()).toBeGreaterThan(afterOne), { timeout: 4000 })
})

test('MetricChart holds nothing once the newest reading has outlived the cadence', async () => {
  // NOW is 330s past the last reading against a 30s cadence, so there is
  // nothing fresh enough to carry: the line must end where the readings did
  const { container } = renderChart([meleys])
  const drawn = (): string => curves(container)[0] ?? ''
  const before = drawn()

  // act, so the sampling tick that fires during the wait is flushed as React
  // would flush it in the browser rather than warned about
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_WAIT_MS))
  })

  expect(drawn()).toBe(before)
})

test('MetricChart reports the age of the newest reading once the collector is late', () => {
  // 330s past the last reading against a 30s cadence, well past the point the
  // lines stop advancing, which is the case the readout exists for. Counted in
  // whole seconds, the rate the frame itself advances at.
  renderChart([meleys, vermithor])

  expect(screen.getByText('Newest reading 330 s ago.')).toBeInTheDocument()
})

// Recharts divides the domain for its own ticks, which labels the present's
// offset and reshuffles every second as the frame slides.
test('MetricChart labels the time axis on quarter hours only', () => {
  const { container } = renderChart([meleys, vermithor])

  // the label group, not the axis group: Recharts hoists tick text out of the
  // axis it belongs to
  const labels = [
    ...container.querySelectorAll(
      '.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value',
    ),
  ].map((tick) => tick.textContent ?? '')
  const minutes = labels.map((label) => Number(label.match(/\d{1,2}:(\d{2})/)?.[1] ?? NaN))
  expect(minutes.length).toBeGreaterThan(0)
  expect(minutes.filter((minute) => minute % 15 !== 0)).toEqual([])
})

test('MetricChart dates the inspected moment, not just its time', () => {
  const { container } = renderChart([meleys, vermithor])

  const plot = container.querySelector('.recharts-wrapper')
  if (!plot) throw new Error('no plot to focus')
  fireEvent.focus(plot)
  fireEvent.keyDown(plot, { key: 'ArrowRight' })

  // derived rather than written out: the suite runs in whatever zone and locale
  // the machine is set to, and the assertion is that a date is there at all
  const day = new Date(T0 + 30_000).toLocaleDateString([], { month: 'short', day: 'numeric' })
  expect(container.querySelector('.recharts-tooltip-wrapper')).toHaveTextContent(day)
})

// Recharts' accessibility layer puts the plot on the tab order and walks it
// with the arrow keys; the tooltip is what it announces at each stop.
test('MetricChart reads out every host at the focused moment, stepped by arrow keys', () => {
  const { container } = renderChart([meleys, vermithor])

  const plot = container.querySelector('.recharts-wrapper')
  expect(container.querySelector('.recharts-surface')).toHaveAttribute('tabindex', '0')
  if (!plot) throw new Error('no plot to focus')

  fireEvent.focus(plot)
  fireEvent.keyDown(plot, { key: 'ArrowRight' })

  const tooltip = container.querySelector('.recharts-tooltip-wrapper')
  expect(tooltip).toHaveTextContent('meleys')
  expect(tooltip).toHaveTextContent('25%')
  expect(tooltip).toHaveTextContent('vermithor')
  expect(tooltip).toHaveTextContent('55%')
})

test('MetricChart names the plot for a screen reader', () => {
  renderChart([meleys])

  expect(screen.getByRole('img', { name: 'CPU by host over the last hour' })).toBeInTheDocument()
})

// The four charts share this component, so what makes them different has to be
// the unit and the copy rather than four near-copies of the drawing code.
test('MetricChart prints a throughput in bytes per second, not as a percentage', () => {
  const traffic = series({
    name: 'meleys',
    points: [
      [0, 1_048_576],
      [30, 2_097_152],
    ],
  })
  const { container } = render(
    <MetricChart
      hosts={[traffic]}
      windowMinutes={60}
      unit="bytes_per_second"
      copy={METRIC_COPY.network}
      now={() => NOW}
    />,
  )

  const plot = container.querySelector('.recharts-wrapper')
  if (!plot) throw new Error('no plot to focus')
  fireEvent.focus(plot)

  // the tooltip is where a single reading prints, so it is where the unit shows
  expect(container.querySelector('.recharts-tooltip-wrapper')).toHaveTextContent('1.0 MB/s')
  expect(screen.queryByText('2097152%')).toBeNull()
})

test('MetricChart scales a throughput axis to the readings in view', () => {
  // a rate has no natural ceiling, so the axis takes one from the data; a
  // 2 MB/s peak makes a 2 MB/s ceiling whose quarters print round, because the
  // ceiling was rounded inside the unit the label prints in
  const traffic = series({ name: 'meleys', points: [[0, 2_097_152]] })
  const { container } = render(
    <MetricChart
      hosts={[traffic]}
      windowMinutes={60}
      unit="bytes_per_second"
      copy={METRIC_COPY.network}
      now={() => NOW}
    />,
  )

  const axis = [...container.querySelectorAll('.recharts-cartesian-axis-tick-value')].map(
    (tick) => tick.textContent,
  )
  expect(axis).toContain('512.0 KB/s')
  expect(axis).toContain('1.0 MB/s')
  expect(axis).toContain('1.5 MB/s')
  // the origin carries no unit
  expect(axis).toContain('0')
})
