import { describe, expect, it } from 'vitest'
import { memberLinkConflict } from '@/memberLinks.js'

const conflict = (
  links: ReadonlyMap<string, string>,
  stripeEmail: string,
  plexEmail: string | null,
) => memberLinkConflict({ links, stripeEmail, plexEmail })

describe('manual identity link invariants', () => {
  it('refuses chains in either insertion order', () => {
    expect(conflict(new Map([['b', 'c']]), 'a', 'b')).not.toBeNull()
    expect(conflict(new Map([['a', 'b']]), 'b', 'c')).not.toBeNull()
  })

  it('refuses self links and cycles', () => {
    expect(conflict(new Map(), 'a', 'a')).not.toBeNull()
    expect(conflict(new Map([['a', 'b']]), 'b', 'a')).not.toBeNull()
    expect(
      conflict(
        new Map([
          ['a', 'b'],
          ['b', 'c'],
        ]),
        'c',
        'a',
      ),
    ).not.toBeNull()
  })

  it('allows several payers, idempotent writes and replacing a payer destination', () => {
    const links = new Map([['a', 'c']])
    expect(conflict(links, 'b', 'c')).toBeNull()
    expect(conflict(links, 'a', 'c')).toBeNull()
    expect(conflict(links, 'a', 'd')).toBeNull()
    expect([...links]).toEqual([['a', 'c']])
  })

  it('allows unlinking and repairing a chain by replacing its first link', () => {
    const links = new Map([
      ['a', 'b'],
      ['b', 'c'],
    ])
    expect(conflict(links, 'b', null)).toBeNull()
    expect(conflict(links, 'a', 'd')).toBeNull()
  })
})
