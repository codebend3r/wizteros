import { expect, test } from '@/test/vi'
import {
  PLAY_KINDS,
  PLAY_QUALITIES,
  PLAY_RANGES,
  rangeProse,
  windowProse,
} from '@/pages/Plays/playsToolbar'

test('the ranges run from a week to all time, with all time last', () => {
  expect(PLAY_RANGES.map((range) => range.days)).toEqual([7, 30, 90, 365, 0])
  expect(PLAY_KINDS.map((kind) => kind.kind)).toEqual(['', 'movie', 'episode', 'track'])
  expect(PLAY_QUALITIES.map((quality) => quality.quality)).toEqual([
    '',
    '4k',
    '1080p',
    '720p',
    'other',
  ])
})

test('a range reads as a span mid-sentence', () => {
  expect(rangeProse(365)).toBe('year')
  expect(rangeProse(0)).toBe('all time')
  expect(windowProse(30)).toBe('over the last 30 days')
  expect(windowProse(0)).toBe('across all time')
})
