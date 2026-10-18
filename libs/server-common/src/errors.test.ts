import { describe, expect, it } from 'vitest'
import { stackOf } from './errors.js'

describe('stackOf', () => {
  it('keeps an Error stack verbatim', () => {
    const error = new Error('failed')
    error.stack = 'recorded stack'
    expect(stackOf(error)).toBe('recorded stack')
  })

  it('falls back to the error text when the stack is absent', () => {
    const error = new Error('failed')
    delete error.stack
    expect(stackOf(error)).toBe('Error: failed')
  })

  it('preserves an empty stack', () => {
    const error = new Error('failed')
    error.stack = ''
    expect(stackOf(error)).toBe('')
  })

  it.each([
    { value: 'failed', text: 'failed' },
    { value: null, text: 'null' },
    { value: undefined, text: 'undefined' },
    { value: 42, text: '42' },
    { value: { message: 'failed' }, text: '[object Object]' },
  ])('stringifies a thrown non-Error: $text', ({ value, text }) => {
    expect(stackOf(value)).toBe(text)
  })
})
