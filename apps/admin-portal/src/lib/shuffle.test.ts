import { expect, test } from '@/test/vi'
import { shuffle } from '@/lib/shuffle'

const items = ['a', 'b', 'c', 'd'] as const

test('keeps every item exactly once', () => {
  const out = shuffle({ items, random: Math.random })
  expect([...out].sort()).toEqual([...items])
})

test('does not mutate the input', () => {
  const input = [...items]
  shuffle({ items: input, random: Math.random })
  expect(input).toEqual([...items])
})

test('orders by the injected random source', () => {
  // Each call draws one number per item; reversing the draws reverses the order.
  const draws = [0.9, 0.6, 0.3, 0.1]
  const random = () => draws.shift() ?? 0
  expect(shuffle({ items, random })).toEqual(['d', 'c', 'b', 'a'])
})
