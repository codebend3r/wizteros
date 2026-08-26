import { afterEach, expect, test } from '@/test/vi'
import {
  CPU_RANGES,
  DEFAULT_RANGE_MINUTES,
  DEFAULT_UPDATE_INTERVAL_MS,
  rangeProse,
  UPDATE_INTERVAL_STOPS_MS,
  useFleetPrefsStore,
} from '@/stores/fleetPrefsStore'

// The store is a module singleton and the suite shares one localStorage, so
// every test hands back the defaults it started from.
afterEach(() => {
  useFleetPrefsStore.setState({
    updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
    rangeMinutes: DEFAULT_RANGE_MINUTES,
  })
  localStorage.removeItem('wz-fleet-prefs')
})

test('the default interval is one second and sits among the stops', () => {
  expect(DEFAULT_UPDATE_INTERVAL_MS).toBe(1000)
  expect(UPDATE_INTERVAL_STOPS_MS).toContain(DEFAULT_UPDATE_INTERVAL_MS)
})

test('a chosen stop is stored and written through to localStorage', () => {
  useFleetPrefsStore.getState().setUpdateIntervalMs(5000)

  expect(useFleetPrefsStore.getState().updateIntervalMs).toBe(5000)
  expect(localStorage.getItem('wz-fleet-prefs')).toContain('5000')
})

test('an interval outside the stops falls back to the default', () => {
  useFleetPrefsStore.getState().setUpdateIntervalMs(1234)

  expect(useFleetPrefsStore.getState().updateIntervalMs).toBe(DEFAULT_UPDATE_INTERVAL_MS)
})

test('a persisted stop survives rehydration', async () => {
  localStorage.setItem(
    'wz-fleet-prefs',
    JSON.stringify({ state: { updateIntervalMs: 2000 }, version: 0 }),
  )

  await useFleetPrefsStore.persist.rehydrate()

  expect(useFleetPrefsStore.getState().updateIntervalMs).toBe(2000)
})

test('a stale persisted value rehydrates as the default, never an arbitrary rate', async () => {
  // a cadence this build no longer offers, or a hand-edited entry
  localStorage.setItem(
    'wz-fleet-prefs',
    JSON.stringify({ state: { updateIntervalMs: 250 }, version: 0 }),
  )

  await useFleetPrefsStore.persist.rehydrate()

  expect(useFleetPrefsStore.getState().updateIntervalMs).toBe(DEFAULT_UPDATE_INTERVAL_MS)
})

test('the ranges run from a week down to an hour, widest first', () => {
  // a week is the monitor's own ceiling: raw samples are pruned at seven days,
  // so anything wider could only answer with less
  expect(CPU_RANGES.map((range) => range.minutes)).toEqual([10_080, 4320, 1440, 720, 360, 60])
  expect(DEFAULT_RANGE_MINUTES).toBe(60)
})

test('a range reads as a span mid-sentence, not as the button label', () => {
  expect(rangeProse(10_080)).toBe('week')
  expect(rangeProse(360)).toBe('6 hours')
})

test('a chosen range is stored and written through to localStorage', () => {
  useFleetPrefsStore.getState().setRangeMinutes(4320)

  expect(useFleetPrefsStore.getState().rangeMinutes).toBe(4320)
  expect(localStorage.getItem('wz-fleet-prefs')).toContain('4320')
})

test('a range the monitor would refuse falls back to the default', () => {
  useFleetPrefsStore.getState().setRangeMinutes(100_000)

  expect(useFleetPrefsStore.getState().rangeMinutes).toBe(DEFAULT_RANGE_MINUTES)
})

test('a persisted range survives rehydration alongside the interval', async () => {
  localStorage.setItem(
    'wz-fleet-prefs',
    JSON.stringify({ state: { updateIntervalMs: 2000, rangeMinutes: 720 }, version: 0 }),
  )

  await useFleetPrefsStore.persist.rehydrate()

  expect(useFleetPrefsStore.getState().rangeMinutes).toBe(720)
  expect(useFleetPrefsStore.getState().updateIntervalMs).toBe(2000)
})
