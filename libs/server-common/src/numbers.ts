/**
 * An integer number or trimmed decimal string, never a boolean or partial parse.
 * Plex's parser disallows a leading plus; environment values allow either sign.
 * String conversion intentionally keeps parseInt's range behaviour: callers own
 * range checks, including rejecting an overflow to Infinity when appropriate.
 */
export const parseInteger = ({
  value,
  allowPlus = true,
}: {
  value: unknown
  allowPlus?: boolean
}): number | null => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  const pattern = allowPlus ? /^[+-]?[0-9]+$/ : /^-?[0-9]+$/
  return pattern.test(text) ? Number.parseInt(text, 10) : null
}
