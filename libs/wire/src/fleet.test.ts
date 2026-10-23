import { describe, expect, it } from 'vitest'
import { hostStatusSchema, metricHistorySchema } from './fleet.js'
import { guardOf } from './guard.js'

describe('hostStatusSchema', () => {
  const isHostStatus = guardOf(hostStatusSchema)

  it('accepts the three verdicts the monitor reaches', () => {
    expect(['ok', 'warn', 'unknown'].every(isHostStatus)).toBe(true)
  })

  it('refuses anything else', () => {
    expect(['down', '', null, 1].some(isHostStatus)).toBe(false)
  })
})

describe('metricHistorySchema', () => {
  const isMetricHistory = guardOf(metricHistorySchema)
  const history = {
    kind: 'network',
    unit: 'bytes_per_second',
    window_minutes: 60,
    hosts: [{ name: 'meleys', points: [{ at: '2026-10-19T00:00:00+00:00', value: 12.5 }] }],
  }

  it('accepts a history and an empty series alike', () => {
    expect(isMetricHistory(history)).toBe(true)
    expect(isMetricHistory({ ...history, hosts: [{ name: 'caraxes', points: [] }] })).toBe(true)
  })

  it('refuses a kind no route serves', () => {
    expect(isMetricHistory({ ...history, kind: 'disk' })).toBe(false)
  })
})
