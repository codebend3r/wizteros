import { expect, test } from '@/test/vi'
import {
  DEFAULT_RANGE_DAYS,
  DEFAULT_TAB,
  PLAYS_TABS,
  readPlaysView,
  rangeSlug,
  writePlaysView,
  type PlaysView,
} from '@/pages/Plays/playsParams'

const read = (search: string) => readPlaysView(new URLSearchParams(search))

const write = (view: PlaysView, search = '') =>
  writePlaysView({ params: new URLSearchParams(search), view }).toString()

const DEFAULTS: PlaysView = {
  tab: DEFAULT_TAB,
  filters: { days: DEFAULT_RANGE_DAYS, host: '', kind: '', quality: '' },
  viewer: null,
  title: null,
  page: 1,
  search: '',
}

test('a bare address opens on the overview, a year wide, with nothing filtered', () => {
  expect(read('')).toEqual(DEFAULTS)
  expect(PLAYS_TABS).toEqual(['overview', 'viewers', 'top', 'rewatched', 'never'])
})

test('every knob on the page is read back from the query string', () => {
  expect(read('view=never&range=30d&type=movie&quality=4k&server=syrax&page=3&q=dune')).toEqual({
    tab: 'never',
    filters: { days: 30, host: 'syrax', kind: 'movie', quality: '4k' },
    viewer: null,
    title: null,
    page: 3,
    search: 'dune',
  })
})

test('all time is written as a word, never as a window of zero days', () => {
  expect(read('range=all').filters.days).toBe(0)
  expect(rangeSlug(0)).toBe('all')
  expect(write({ ...DEFAULTS, filters: { ...DEFAULTS.filters, days: 0 } })).toBe('range=all')
})

test('a viewer named in the address is the view, whatever tab the address says', () => {
  const view = read('view=never&user=42')
  expect(view.viewer).toBe(42)
  expect(view.tab).toBe('viewers')
})

test('a title named in the address is the view, over whichever tab is selected', () => {
  const view = read('view=top&title=movie%3Aheat%3A1995')
  expect(view.title).toBe('movie:heat:1995')
  expect(view.tab).toBe('top')
  // the key carries the title itself, punctuation and all, so it has to
  // survive the round trip through the address bar intact
  expect(write({ ...DEFAULTS, title: 'album:kid a:radiohead' })).toBe(
    'title=album%3Akid+a%3Aradiohead',
  )
  expect(read('title=').title).toBeNull()
})

test('a stale or hand-edited address falls back to the defaults, never to a filter the monitor would refuse', () => {
  expect(read('view=charts&range=14d&type=clip&quality=hd&user=-3&page=0')).toEqual(DEFAULTS)
  expect(read('page=two').page).toBe(1)
  expect(read('page=4.5').page).toBe(1)
})

test('a default is left out of the address, so the same view is always the same url', () => {
  expect(write(DEFAULTS)).toBe('')
  expect(write({ ...DEFAULTS, page: 1, search: '' })).toBe('')
  expect(
    write({
      tab: 'top',
      filters: { days: 7, host: 'meleys', kind: 'episode', quality: '1080p' },
      viewer: null,
      title: null,
      page: 2,
      search: 'qi',
    }),
  ).toBe('view=top&range=7d&type=episode&quality=1080p&server=meleys&page=2&q=qi')
})

test('a parameter the page does not own rides through untouched', () => {
  expect(write({ ...DEFAULTS, tab: 'viewers' }, 'utm_source=slack')).toBe(
    'utm_source=slack&view=viewers',
  )
})

test('what the address says round-trips back to the same view', () => {
  const view: PlaysView = {
    tab: 'viewers',
    filters: { days: 90, host: 'vhagar', kind: 'track', quality: 'other' },
    viewer: 7,
    title: 'movie:heat:1995',
    page: 5,
    search: '',
  }
  expect(read(write(view))).toEqual(view)
})
