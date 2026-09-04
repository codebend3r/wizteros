import { expect, test } from '@/test/vi'
import { niceCeiling, quarterTicks } from '@/pages/Income/chartFrame'

test('niceCeiling rounds a little above the peak to a figure that quarters cleanly', () => {
  expect(niceCeiling(0)).toBe(100)
  expect(niceCeiling(454)).toBe(500)
  expect(niceCeiling(28)).toBe(40)
  expect(niceCeiling(7)).toBe(8)
  expect(niceCeiling(1200)).toBe(1400)
  expect(quarterTicks({ ceiling: niceCeiling(454) }).every(Number.isInteger)).toBe(true)
})

test('quarterTicks spans zero to the ceiling, or mirrors it below zero', () => {
  expect(quarterTicks({ ceiling: 100 })).toEqual([0, 25, 50, 75, 100])
  expect(quarterTicks({ ceiling: 100, mirrored: true })).toEqual([
    -100, -75, -50, -25, 0, 25, 50, 75, 100,
  ])
})
