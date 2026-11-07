import { expect, test } from '@/test/vi'
import { formatRate, metricScale, niceCeiling } from '@/pages/Fleet/metricScale'

test('a percent scale is always the whole 0-100, so a full disk looks full', () => {
  const disks = metricScale({ unit: 'percent', peak: 93.4 })

  expect(disks.ticks).toEqual([0, 25, 50, 75, 100])
  expect(disks.min).toBe(0)
  expect(disks.max).toBe(100)
  expect(disks.format(75)).toBe('75%')
  // the tooltip prints through the same formatter and keeps the reading whole
  expect(disks.format(89.21)).toBe('89.21%')
})

test('a quiet line and an empty chart get the same 0-100', () => {
  expect(metricScale({ unit: 'percent', peak: 3 }).ticks).toEqual([0, 25, 50, 75, 100])
  expect(metricScale({ unit: 'percent', peak: 0 }).ticks).toEqual([0, 25, 50, 75, 100])
})

test('a rate scale takes its ceiling from the readings, since bytes have none', () => {
  const MB = 1024 ** 2
  const scale = metricScale({ unit: 'bytes_per_second', peak: 1_500_000 })

  expect(scale.max).toBe(2 * MB)
  expect(scale.ticks).toEqual([0, 0.5 * MB, 1 * MB, 1.5 * MB, 2 * MB])
  // and every one of them prints as a round number, which is the point
  expect(scale.ticks.map(scale.format)).toEqual([
    '0',
    '512.0 KB/s',
    '1.0 MB/s',
    '1.5 MB/s',
    '2.0 MB/s',
  ])
})

test('a rate axis leaves room its labels need and a percent axis does not', () => {
  /* "125.0 MB/s" does not fit where "100%" does, and a label wider than its
     margin is drawn over the plot */
  expect(metricScale({ unit: 'bytes_per_second', peak: 1 }).axisWidth).toBeGreaterThan(
    metricScale({ unit: 'percent', peak: 1 }).axisWidth,
  )
})

test('the axis widens with its widest label, so none is wrapped onto two lines', () => {
  const MB = 1024 ** 2
  /* "100.0 MB/s" is one character wider than "75.0 MB/s", and that character
     is what Recharts broke the label at */
  const wide = metricScale({ unit: 'bytes_per_second', peak: 100 * MB })
  const narrow = metricScale({ unit: 'bytes_per_second', peak: 8 * MB })

  expect(wide.format(wide.max)).toBe('100.0 MB/s')
  expect(narrow.format(narrow.max)).toBe('10.0 MB/s')
  expect(wide.axisWidth).toBeGreaterThan(narrow.axisWidth)
  // seven and a half pixels a character at the axis font, plus the margin
  expect(wide.axisWidth).toBeGreaterThanOrEqual('100.0 MB/s'.length * 7.5)
})

test('niceCeiling rounds up to a readable number rather than to the peak itself', () => {
  /* under a kilobyte there is no binary unit to round inside, so this is plain
     decimal rounding */
  expect(niceCeiling(0.4)).toBe(0.5)
  expect(niceCeiling(7)).toBe(10)
  /* 2.5 earns its place: without it a 2.4 peak rounds to 5 and the chart
     spends its whole top half empty */
  expect(niceCeiling(2.4)).toBe(2.5)
})

/* A decimal ceiling over a 1024-based formatter is what produced axes reading
   "610.4 KB/s": round before formatBytes divides by 1024, not after. */
test('niceCeiling rounds inside the unit the label will be printed in', () => {
  expect(niceCeiling(1200)).toBe(2 * 1024)
  expect(niceCeiling(1024 ** 2 * 2)).toBe(1024 ** 2 * 2)
  expect(niceCeiling(2_400_000)).toBe(1024 ** 2 * 2.5)
  expect(niceCeiling(1024 ** 3)).toBe(1024 ** 3)
})

test('niceCeiling refuses to return a zero-height axis', () => {
  /* an axis from 0 to 0 has nothing to divide by, and every point on it would
     be drawn at a coordinate of NaN */
  expect(niceCeiling(0)).toBe(1)
  expect(niceCeiling(-5)).toBe(1)
  expect(niceCeiling(Number.NaN)).toBe(1)
  expect(niceCeiling(Number.POSITIVE_INFINITY)).toBe(1)
})

test('a rate reads in bytes per second, and zero needs no unit at all', () => {
  expect(formatRate(0)).toBe('0')
  expect(formatRate(1536)).toBe('1.5 KB/s')
  expect(formatRate(1024 ** 3)).toBe('1.0 GB/s')
})
