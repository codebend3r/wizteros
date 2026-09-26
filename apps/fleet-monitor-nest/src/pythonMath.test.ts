import { describe, expect, it } from 'vitest'
import { pythonRound } from '@/pythonMath.js'

// Every expected value here is what CPython 3.14 printed for round(value, digits)
// (or round(value) at zero digits), so the port is measured against Python
// itself rather than against a reading of its documentation.
const PYTHON: readonly (readonly [number, number, number])[] = [
  [0.5, 0, 0],
  [1.5, 0, 2],
  [2.5, 0, 2],
  [-2.5, 0, -2],
  [-3.5, 0, -4],
  [66.5, 0, 66],
  [37.5, 0, 38],
  [12.25, 1, 12.2],
  [12.35, 1, 12.3],
  [0.05, 1, 0.1],
  [12.3456, 1, 12.3],
  [-0.75, 1, -0.8],
  [100.0, 1, 100.0],
  [49.95, 1, 50.0],
  [0.125, 2, 0.12],
  [2.675, 2, 2.67],
  [99.9995, 3, 99.999],
  [1.0005, 3, 1.0],
  [33.333333, 3, 33.333],
]

describe('pythonRound', () => {
  it.each(PYTHON)('rounds %d to %d places as Python does: %d', (value, digits, expected) => {
    expect(pythonRound({ value, digits })).toBe(expected)
  })

  it('rounds to a whole number when no digits are given, like round(x)', () => {
    expect(pythonRound({ value: 2.5 })).toBe(2)
    expect(pythonRound({ value: 3.5 })).toBe(4)
  })
})
