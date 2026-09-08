/**
 * Returns a copy of `items` in random order, drawing one number per item from
 * `random`. Injecting the source keeps callers deterministic under test.
 */
export const shuffle = <T>({
  items,
  random,
}: {
  items: ReadonlyArray<T>
  random: () => number
}): ReadonlyArray<T> =>
  items
    .map((item) => ({ item, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item)
