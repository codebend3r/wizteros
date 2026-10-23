import { describe, expect, it } from 'vitest'
import { guardOf } from './guard.js'
import { playHistorySchema, titleHistorySchema } from './plays.js'

const row = {
  viewed_at: '2026-10-19T20:00:00+00:00',
  host: 'meleys',
  kind: 'episode',
  group_key: 'show:Severance',
  title: 'Good News About Hell',
  parent_title: 'Season 1',
  grandparent_title: 'Severance',
  index: 1,
  parent_index: 1,
  year: 2022,
  quality: '1080p',
  device: 'Apple TV',
  library: 'TV',
  duration_ms: 3_420_000,
}

describe('playHistorySchema', () => {
  const isPlayHistory = guardOf(playHistorySchema)
  const page = { total: 1, page: 1, page_size: 50, rows: [{ ...row, account_id: 1, viewer: 'cj' }] }

  it('accepts a viewer row with who finished it beside it', () => {
    expect(isPlayHistory(page)).toBe(true)
  })

  it('refuses a row that does not name its viewer', () => {
    expect(isPlayHistory({ ...page, rows: [row] })).toBe(false)
  })
})

describe('titleHistorySchema', () => {
  it('accepts the null kind of a key nothing in the ledger answers to', () => {
    const empty = {
      key: 'movie:Gone:1999',
      kind: null,
      title: '',
      context: null,
      year: null,
      quality: null,
      viewers: 0,
      items: 0,
      rewatches: 0,
      first_viewed_at: null,
      last_viewed_at: null,
      hosts: [],
      total: 0,
      page: 1,
      page_size: 50,
      rows: [],
    }
    expect(guardOf(titleHistorySchema)(empty)).toBe(true)
  })
})
