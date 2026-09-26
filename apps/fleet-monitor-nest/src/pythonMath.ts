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
