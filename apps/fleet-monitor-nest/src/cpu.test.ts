import { describe, expect, it } from 'vitest'
import { METRICS, busySeries } from '@/cpu.js'
import type { Series } from '@/store.js'
import { addSeconds } from '@/time.js'

const T0 = new Date(Date.UTC(2026, 7, 23, 12, 0, 0))

const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

describe('METRICS', () => {
  it('covers every /proc/stat field', () => {
    // the endpoint asks the store for exactly what parseStat writes; a field
    // missing here would silently skew every total the derivation sums
    expect(METRICS).toEqual([
      'cpu.total.user',
      'cpu.total.nice',
      'cpu.total.system',
      'cpu.total.idle',
      'cpu.total.iowait',
      'cpu.total.irq',
      'cpu.total.softirq',
      'cpu.total.steal',
    ])
  })
})

describe('busySeries', () => {
  it('derives the percent from counter deltas', () => {
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 0],
        [at(30), 25],
        [at(60), 75],
      ],
      'cpu.total.idle': [
        [at(0), 0],
        [at(30), 75],
        [at(60), 125],
      ],
    })

    expect(points).toEqual([
      [at(30), 25],
      [at(60), 50],
    ] satisfies Series)
  })

  it('counts iowait as not busy', () => {
    // iowait is time the CPU spent waiting, not working; counting it as busy
    // would paint a disk-bound NAS as compute-bound
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 0],
        [at(30), 20],
      ],
      'cpu.total.idle': [
        [at(0), 0],
        [at(30), 40],
      ],
      'cpu.total.iowait': [
        [at(0), 0],
        [at(30), 40],
      ],
    })

    expect(points).toEqual([[at(30), 20]] satisfies Series)
  })

  it('drops the delta across a reboot', () => {
    // a reboot zeroes /proc/stat; that delta rendered anyway would be a spike
    // to 100% that never happened
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 5000],
        [at(30), 10],
        [at(60), 20],
      ],
      'cpu.total.idle': [
        [at(0), 5000],
        [at(30), 30],
        [at(60), 70],
      ],
    })

    expect(points).toEqual([[at(60), 20]] satisfies Series)
  })

  it('skips a tick that never reported idle', () => {
    // without idle a tick cannot be judged; the pair spanning it is still a
    // true average over the wider interval, so the series bridges rather than
    // inventing a value
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 0],
        [at(30), 10],
        [at(60), 50],
      ],
      'cpu.total.idle': [
        [at(0), 0],
        [at(60), 50],
      ],
    })

    expect(points).toEqual([[at(60), 50]] satisfies Series)
  })

  it('drops a pair whose field sets differ', () => {
    // a tick that recorded fewer fields than its neighbor makes the total
    // delta wrong by whatever the missing counters advanced; unjudgeable
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 0],
        [at(30), 50],
      ],
      'cpu.total.idle': [
        [at(0), 0],
        [at(30), 50],
      ],
      'cpu.total.steal': [[at(30), 5]],
    })

    expect(points).toEqual([])
  })

  it('drops a pair with no elapsed work', () => {
    const points = busySeries({
      'cpu.total.user': [
        [at(0), 100],
        [at(30), 100],
      ],
      'cpu.total.idle': [
        [at(0), 200],
        [at(30), 200],
      ],
    })

    expect(points).toEqual([])
  })

  it('is empty for no input', () => {
    expect(busySeries({})).toEqual([])
  })
})
