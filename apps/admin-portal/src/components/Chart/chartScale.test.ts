import { expect, test } from '@/test/vi'
import { axisWidthFor, quarterTicks } from '@/components/Chart/chartScale'

test('quarterTicks spans zero to the ceiling, or mirrors it below zero', () => {
  expect(quarterTicks({ ceiling: 100 })).toEqual([0, 25, 50, 75, 100])
  expect(quarterTicks({ ceiling: 100, mirrored: true })).toEqual([
    -100, -75, -50, -25, 0, 25, 50, 75, 100,
  ])
})

test('axisWidthFor budgets for the widest label the axis will draw', () => {
  const narrow = axisWidthFor({ ticks: [0, 100], format: (value) => `${value}%` })
  const wide = axisWidthFor({ ticks: [0, 100], format: (value) => `${value}.0 MB/s` })
  expect(wide).toBeGreaterThan(narrow)
  expect(narrow).toBe(Math.ceil(4 * 7.5 + 12))
})
