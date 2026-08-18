import { expect, test } from '@/test/vi'
import { isLiveQueryKey } from '@/lib/queryPersistence'

// The persister exists for the ~15s members call; the fleet page inherited it
// silently. A restored fleet paints a half-hour-old heartbeat and a frozen
// `stale: false` as the present, which is the one thing that page must not do.
test('isLiveQueryKey names the fleet queries as never restorable', () => {
  expect(isLiveQueryKey(['fleet'])).toBe(true)
  expect(isLiveQueryKey(['fleet-incidents', 24])).toBe(true)
})

test('isLiveQueryKey leaves the slow lookups the persister exists for cacheable', () => {
  expect(isLiveQueryKey(['members'])).toBe(false)
  expect(isLiveQueryKey([])).toBe(false)
})
