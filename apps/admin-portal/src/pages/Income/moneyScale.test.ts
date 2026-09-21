import { expect, test } from '@/test/vi'
import { quarterTicks } from '@/components/Chart/chartScale'
import { moneyScale, niceCeiling, signed } from '@/pages/Income/moneyScale'

test('niceCeiling rounds a little above the peak to a figure that quarters cleanly', () => {
  expect(niceCeiling(0)).toBe(100)
  expect(niceCeiling(454)).toBe(500)
  expect(niceCeiling(28)).toBe(40)
  expect(niceCeiling(7)).toBe(8)
  expect(niceCeiling(1200)).toBe(1400)
  expect(quarterTicks({ ceiling: niceCeiling(454) }).every(Number.isInteger)).toBe(true)
})

test('signed says which way a figure moved, and leaves zero alone', () => {
  expect(signed(0)).toBe('$0')
  expect(signed(12)).toBe('+$12')
  expect(signed(-12)).toBe('-$12')
})

test('moneyScale runs from zero, or mirrors the ceiling below it', () => {
  const up = moneyScale({ peak: 454, axisWidth: 56 })
  expect([up.min, up.max]).toEqual([0, 500])
  expect(up.ticks).toEqual([0, 125, 250, 375, 500])
  expect(up.format(500)).toBe('$500')
  expect(up.axisWidth).toBe(56)

  const both = moneyScale({ peak: 90, mirrored: true, axisWidth: 60 })
  expect([both.min, both.max]).toEqual([-100, 100])
  expect(both.ticks).toEqual([-100, -75, -50, -25, 0, 25, 50, 75, 100])
  expect(both.format(-25)).toBe('-$25')
})
