import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import type { CpuHostSeries } from '@/lib/fleetApi'
import { CpuChart } from '@/pages/Fleet/CpuChart'

const T0 = Date.parse('2026-08-23T12:00:00+00:00')

const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString()

const series = ({
  name,
  points,
}: {
  name: string
  points: readonly (readonly [number, number])[]
}): CpuHostSeries => ({
  name,
  points: points.map(([offset, busy]) => ({ at: at(offset), busy_percent: busy })),
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

const renderChart = (chartHosts: readonly CpuHostSeries[]) =>
  render(<CpuChart hosts={chartHosts} windowMinutes={60} now={() => NOW} />)

test('CpuChart legend names every host, including one with nothing to draw', () => {
  renderChart([meleys, series({ name: 'caraxes', points: [] })])

  // the host names also head the table columns, so scope to the legend list
  const legend = screen.getByRole('list')
  expect(within(legend).getByText('meleys')).toBeInTheDocument()
  expect(within(legend).getByText('caraxes')).toBeInTheDocument()
  // absent is absent: a host that reported nothing says so instead of drawing
  // a flat line at zero
  expect(within(legend).getByText('no readings')).toBeInTheDocument()
})

test('CpuChart says so when no host reported at all', () => {
  renderChart([series({ name: 'meleys', points: [] })])

  expect(screen.getByText(/No CPU readings in the last hour/)).toBeInTheDocument()
  expect(screen.queryByRole('table')).toBeNull()
})

test('CpuChart draws one line per host in its own series class', () => {
  const { container } = renderChart([meleys, vermithor])

  const lines = container.querySelectorAll('path')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toHaveClass('series1')
  expect(lines[1]).toHaveClass('series2')
})

test('CpuChart breaks a line across a gap instead of bridging it', () => {
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

  expect(container.querySelectorAll('path')).toHaveLength(2)
})

test('CpuChart counts freshness in whole seconds, the rate the frame advances', () => {
  render(<CpuChart hosts={[meleys]} windowMinutes={60} now={() => T0 + 90_500} />)

  // newest reading sits at T0+60s, so a 90.5s present rounds to 31s of age
  expect(screen.getByText('Newest reading 31 s ago.')).toBeInTheDocument()
})

test('CpuChart carries the newest reading forward a point per second', async () => {
  // a present 10s past the last reading, well inside the 30s cadence, so the
  // value is held rather than dropped as stale
  const held = T0 + 70_000
  const { container } = render(<CpuChart hosts={[meleys]} windowMinutes={60} now={() => held} />)

  const drawn = (): string => container.querySelector('path')?.getAttribute('d') ?? ''
  // nothing is held before the first tick: the line still ends on the reading
  expect(drawn()).not.toContain('L264.0 145.0')

  // one tick later the line reaches the right edge (x=264) at the last
  // reading's 30% (y=145), which is the held second
  await waitFor(() => expect(drawn()).toContain('L264.0 145.0'), { timeout: 4000 })
})

test('CpuChart holds nothing once the newest reading has outlived the cadence', async () => {
  // NOW is 330s past the last reading against a 30s cadence, so there is
  // nothing fresh enough to carry: the line must end where the readings did
  const { container } = renderChart([meleys])
  const drawn = (): string => container.querySelector('path')?.getAttribute('d') ?? ''
  const before = drawn()

  // act, so the sampling tick that fires during the wait is flushed as React
  // would flush it in the browser rather than warned about
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_WAIT_MS))
  })

  expect(drawn()).toBe(before)
})

test('CpuChart dates its newest reading against the moving present', () => {
  renderChart([meleys, vermithor])

  expect(screen.getByText('Newest reading 330 s ago.')).toBeInTheDocument()
})

test('CpuChart offers every reading in a table, newest first, absent as --', () => {
  renderChart([meleys, vermithor])

  const table = screen.getByRole('table')
  expect(table).toBeInTheDocument()

  const rows = screen.getAllByRole('row')
  // header plus one row per distinct reading time
  expect(rows).toHaveLength(4)
  // newest first: meleys reported 30% at the last tick, vermithor nothing
  expect(rows[1]).toHaveTextContent('30%')
  expect(rows[1]).toHaveTextContent('--')
  expect(rows[3]).toHaveTextContent('20%')
  expect(rows[3]).toHaveTextContent('50%')
})

test('CpuChart reads out every host at the focused moment, stepped by arrow keys', () => {
  renderChart([meleys, vermithor])

  const inspector = screen.getByRole('slider', { name: 'Reading time' })
  fireEvent.focus(inspector)

  // focus lands on the latest reading; vermithor has none there
  expect(inspector.getAttribute('aria-valuetext')).toContain('meleys 30%')
  expect(inspector.getAttribute('aria-valuetext')).not.toContain('vermithor')

  fireEvent.keyDown(inspector, { key: 'ArrowLeft' })
  expect(inspector.getAttribute('aria-valuetext')).toContain('meleys 25%')
  expect(inspector.getAttribute('aria-valuetext')).toContain('vermithor 55%')

  fireEvent.keyDown(inspector, { key: 'Home' })
  expect(inspector.getAttribute('aria-valuetext')).toContain('meleys 20%')
  expect(inspector.getAttribute('aria-valuetext')).toContain('vermithor 50%')
})

test('CpuChart shows the same readings in a tooltip while inspecting', () => {
  renderChart([meleys, vermithor])

  const inspector = screen.getByRole('slider', { name: 'Reading time' })
  fireEvent.focus(inspector)
  fireEvent.keyDown(inspector, { key: 'Home' })

  // the tooltip's list renders ahead of the legend's, and the readings also
  // live in the table and on the y axis, so scope to it
  const tooltip = screen.getAllByRole('list')[0]!
  expect(within(tooltip).getByText('20%')).toBeInTheDocument()
  expect(within(tooltip).getByText('50%')).toBeInTheDocument()
  expect(within(tooltip).getByText('meleys')).toBeInTheDocument()
  expect(within(tooltip).getByText('vermithor')).toBeInTheDocument()
})
