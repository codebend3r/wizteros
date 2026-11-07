/** The class attribute for a set of parts, dropping the absent ones so no
    stray space or "undefined" reaches the DOM. */
export const classNames = (parts: readonly (string | false | undefined)[]): string =>
  parts.filter((part): part is string => !!part).join(' ')
