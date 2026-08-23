import { afterEach, expect, test } from '@/test/vi'
import {
  DEFAULT_UPDATE_INTERVAL_MS,
  UPDATE_INTERVAL_STOPS_MS,
  useFleetPrefsStore,
} from '@/stores/fleetPrefsStore'

// The store is a module singleton and the suite shares one localStorage, so
// every test hands back the defaults it started from.
afterEach(() => {
  useFleetPrefsStore.setState({ updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS })
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
