import { afterEach, expect, test } from '@/test/vi'
import {
  DEFAULT_RANGE_DAYS,
  DEFAULT_TAB,
  PLAYS_TABS,
  selectFilters,
  usePlaysPrefsStore,
} from '@/stores/playsPrefsStore'

// The store is a module singleton and the suite shares one localStorage, so
// every test hands back the defaults it started from.
afterEach(() => {
  usePlaysPrefsStore.setState({
    rangeDays: DEFAULT_RANGE_DAYS,
    host: '',
    kind: '',
    quality: '',
    tab: DEFAULT_TAB,
  })
  localStorage.removeItem('wz-plays-prefs')
})

test('the page opens on the overview, a year wide, with nothing filtered', () => {
  const state = usePlaysPrefsStore.getState()
  expect(state.tab).toBe('overview')
  expect(selectFilters(state)).toEqual({ days: 365, host: '', kind: '', quality: '' })
  expect(PLAYS_TABS).toEqual(['overview', 'viewers', 'top', 'rewatched', 'never'])
})

test('a chosen range, type, quality and server are stored and written through', () => {
  const { setRangeDays, setKind, setQuality, setHost, setTab } = usePlaysPrefsStore.getState()
  setRangeDays(0)
  setKind('movie')
  setQuality('4k')
  setHost('meleys')
  setTab('never')

  expect(selectFilters(usePlaysPrefsStore.getState())).toEqual({
    days: 0,
    host: 'meleys',
    kind: 'movie',
    quality: '4k',
  })
  expect(usePlaysPrefsStore.getState().tab).toBe('never')
  expect(localStorage.getItem('wz-plays-prefs')).toContain('"quality":"4k"')
})

test('a range the monitor does not offer falls back to the default', () => {
  // the other setters are typed to their lists; the range is a bare number,
  // so it is the one a caller can get wrong at runtime
  usePlaysPrefsStore.getState().setRangeDays(45)

  expect(usePlaysPrefsStore.getState().rangeDays).toBe(DEFAULT_RANGE_DAYS)
})

test('persisted preferences survive rehydration', async () => {
  localStorage.setItem(
    'wz-plays-prefs',
    JSON.stringify({
      state: { rangeDays: 30, host: 'syrax', kind: 'track', quality: 'other', tab: 'top' },
      version: 0,
    }),
  )

  await usePlaysPrefsStore.persist.rehydrate()

  expect(selectFilters(usePlaysPrefsStore.getState())).toEqual({
    days: 30,
    host: 'syrax',
    kind: 'track',
    quality: 'other',
  })
  expect(usePlaysPrefsStore.getState().tab).toBe('top')
})

test('a stale or hand-edited entry rehydrates as the default, never as a filter the monitor would refuse', async () => {
  localStorage.setItem(
    'wz-plays-prefs',
    JSON.stringify({
      state: { rangeDays: 14, host: 7, kind: 'clip', quality: 'hd', tab: 'charts' },
      version: 0,
    }),
  )

  await usePlaysPrefsStore.persist.rehydrate()

  expect(selectFilters(usePlaysPrefsStore.getState())).toEqual({
    days: DEFAULT_RANGE_DAYS,
    host: '',
    kind: '',
    quality: '',
  })
  expect(usePlaysPrefsStore.getState().tab).toBe(DEFAULT_TAB)
})
