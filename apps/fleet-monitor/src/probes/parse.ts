import type { Sample } from '@/probes/types.js'

// Python's float() accepts surrounding whitespace, a sign, decimals and an
// exponent; Number() is looser (it reads '' and hex as numbers), so the token
// is matched against that grammar first. inf and nan are left out because
// they would be rejected as non-finite anyway.
const FLOAT_TOKEN = /^\s*[+-]?(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)\s*$/i

/**
 * A token as a finite number, or null when it is not one.
 *
 * Every value a probe reads arrives as an unvalidated string, and one
 * malformed token reaching a parse costs the whole host's round. NaN and
 * infinities are rejected too: they parse cleanly and then poison every
 * average and comparison downstream.
 *
 * This is the one numeric gate for every probe.
 */
export const number = (token: string): number | null => {
  if (!FLOAT_TOKEN.test(token)) {
    return null
  }
  const value = Number(token)
  return Number.isFinite(value) ? value : null
}

/**
 * A usage ratio, or nothing when there is no ceiling to divide by.
 *
 * Two probes derive a headroom ratio from a reading and its limit, and both
 * have to answer the same question about a missing or zero ceiling. Dividing
 * is not the interesting part; agreeing on when not to is.
 */
export const ratio = ({
  metric,
  value,
  ceiling,
}: {
  metric: string
  value: number | null
  ceiling: number
}): readonly Sample[] =>
  value === null || ceiling <= 0 ? [] : [{ metric, value: value / ceiling, kind: 'gauge' }]
