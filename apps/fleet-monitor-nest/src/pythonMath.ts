// Python's number formatting, where the API served numbers Python computed.

/**
 * Python's `round(value, digits)`: the decimal nearest the double's exact
 * value, with an exact tie going to the even digit. `toFixed` finds the same
 * nearest decimal but sends a tie away from zero, and `Math.round(value * 1000)`
 * rounds the product rather than the value, so neither alone matches what the
 * Python API served.
 *
 * A double sits exactly halfway at `digits` places only when it is an odd
 * multiple of 2^-(digits + 1); no other decimal ending in 5 is exact in
 * binary. Scaling by a power of two is exact, so that test is too.
 */
export const pythonRound = ({ value, digits = 0 }: { value: number; digits?: number }): number => {
  const halves = value * 2 ** (digits + 1)
  if (!Number.isInteger(halves) || Math.abs(halves % 2) !== 1) {
    return Number(value.toFixed(digits))
  }
  const scale = 10 ** digits
  const below = Math.floor(value * scale)
  return (below % 2 === 0 ? below : below + 1) / scale
}

/**
 * Python's `sum()` over floats, which since 3.12 is Neumaier's compensated
 * summation rather than a plain running total. The two part ways in the last
 * bit often enough to matter: a bucket mean of four one-decimal readings lands
 * on a rounding tie, and that last bit decides which way `round(x, 1)` breaks
 * it. The compensation is applied the way CPython applies it, only when it is
 * nonzero and finite.
 */
export const pythonSum = (values: readonly number[]): number => {
  const { total, compensation } = values.reduce(
    (running, value) => {
      const next = running.total + value
      const lost =
        Math.abs(running.total) >= Math.abs(value)
          ? running.total - next + value
          : value - next + running.total
      return { total: next, compensation: running.compensation + lost }
    },
    { total: 0, compensation: 0 },
  )
  return compensation !== 0 && Number.isFinite(compensation) ? total + compensation : total
}

/**
 * Python's `dividend // divisor` on floats, which is not `Math.floor` of the
 * quotient. CPython divides out the exact `fmod` remainder first and snaps
 * that to an integer, so a quotient that rounds up to a whole number in
 * floating point still floors below it: `3801.0 // 15.083333333333334` is 251
 * where `Math.floor(3801 / 15.083333333333334)` is 252. A window of 181
 * minutes, which the portal asks for, has exactly that width.
 */
export const floorDivide = ({
  dividend,
  divisor,
}: {
  dividend: number
  divisor: number
}): number => {
  // `%` is C's fmod, so the remainder carries the dividend's sign; Python's
  // takes the divisor's, and moving it across borrows one from the quotient
  const remainder = dividend % divisor
  const remainderNegative = remainder < 0
  const divisorNegative = divisor < 0
  const borrow = remainder !== 0 && remainderNegative !== divisorNegative ? 1 : 0
  const quotient = (dividend - remainder) / divisor - borrow
  if (quotient === 0) {
    return 0
  }
  const floored = Math.floor(quotient)
  return quotient - floored > 0.5 ? floored + 1 : floored
}
