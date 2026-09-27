// The Python bridge made its Wizarr and Stripe calls one at a time, in list
// order, and several behaviors lean on that: a checkout that raises part-way
// has written exactly the records before the failure, and the tests assert
// the order the calls went out in. Promise.all would fire them together, so
// every loop over a service call goes through one of these instead.

/** Run `run` on each item in turn, each awaited before the next starts. */
export const eachInOrder = async <T>({
  items,
  run,
}: {
  items: readonly T[]
  run: (item: T) => Promise<void>
}): Promise<void> =>
  items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    await run(item)
  }, Promise.resolve())

/** `eachInOrder`, keeping what each call answered, in item order. */
export const mapInOrder = async <T, R>({
  items,
  run,
}: {
  items: readonly T[]
  run: (item: T) => Promise<R>
}): Promise<R[]> =>
  items.reduce<Promise<R[]>>(async (previous, item) => {
    const done = await previous
    return [...done, await run(item)]
  }, Promise.resolve([]))
