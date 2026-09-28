import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rotateBaselineInvites } from '@/baseline.js'
import { sweepAlerts } from '@/changeAlert.js'
import { msUntilHour, reconcileOnce, rotateOnce, startLoops, type Timers } from '@/loops.js'
import { reconcilePendingExpiries } from '@/reconcile.js'
import { UpstreamSnapshot } from '@/snapshot.js'
import { checkPaymentStates, checkTierScopes, checkVipAccess } from '@/sweeps.js'
import { asBridge, fakeBridge } from '@/test/fakes.js'

vi.mock('@/sweeps.js', () => ({
  checkTierScopes: vi.fn(async () => ({})),
  checkVipAccess: vi.fn(async () => []),
  checkPaymentStates: vi.fn(async () => []),
}))
vi.mock('@/reconcile.js', () => ({ reconcilePendingExpiries: vi.fn(async () => 0) }))
vi.mock('@/baseline.js', () => ({
  rotateBaselineInvites: vi.fn(async () => ({ minted: [], skipped: [], reaped: [] })),
}))

const bridge = asBridge(fakeBridge({ dbPath: '/nowhere/bridge.db' }))

// Let every queued promise continuation run.
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

type Scheduled = { run: () => void; ms: number; cleared: boolean }

/** Timers that only fire when a test says so, and a clock the test sets. */
const manualTimers = (now: Date) => {
  const scheduled: Scheduled[] = []
  const timers: Timers = {
    setTimeout: (run, ms) => {
      const entry: Scheduled = { run, ms, cleared: false }
      scheduled.push(entry)
      // A real handle, never started, so the type is the one Node returns.
      const handle = setTimeout(() => {}, 0)
      clearTimeout(handle)
      handles.set(handle, entry)
      return handle
    },
    clearTimeout: (handle) => {
      const entry = handles.get(handle)
      if (entry) {
        entry.cleared = true
      }
    },
    now: () => now,
  }
  const handles = new Map<NodeJS.Timeout, Scheduled>()
  return { timers, scheduled }
}

describe('msUntilHour', () => {
  it('waits until later today when the hour has not come yet', () => {
    const now = new Date(2026, 8, 27, 1, 30, 0)
    expect(msUntilHour({ hour: 3, now })).toBe(90 * 60 * 1000)
  })

  it('waits until tomorrow when the hour has passed', () => {
    const now = new Date(2026, 8, 27, 4, 0, 0)
    expect(msUntilHour({ hour: 3, now })).toBe(23 * 3600 * 1000)
  })

  it('never answers zero: exactly on the hour means the next day', () => {
    const now = new Date(2026, 8, 27, 3, 0, 0)
    expect(msUntilHour({ hour: 3, now })).toBe(24 * 3600 * 1000)
  })
})

describe('reconcileOnce', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('runs the three alarms, then the expiry sweep, in that order', async () => {
    const order: string[] = []
    vi.mocked(checkTierScopes).mockImplementationOnce(async () => (order.push('tiers'), {}))
    vi.mocked(checkVipAccess).mockImplementationOnce(async () => (order.push('vips'), []))
    vi.mocked(checkPaymentStates).mockImplementationOnce(async () => (order.push('dunning'), []))
    vi.mocked(reconcilePendingExpiries).mockImplementationOnce(
      async () => (order.push('expiry'), 0),
    )
    await reconcileOnce({ bridge, alerts: sweepAlerts() })
    expect(order).toEqual(['tiers', 'vips', 'dunning', 'expiry'])
  })

  it('still runs every other pass when one throws, and logs the one that did', async () => {
    vi.mocked(checkVipAccess).mockRejectedValueOnce(new Error('wizarr down'))
    await reconcileOnce({ bridge, alerts: sweepAlerts() })
    expect(checkPaymentStates).toHaveBeenCalledTimes(1)
    expect(reconcilePendingExpiries).toHaveBeenCalledTimes(1)
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'vip access check failed',
      expect.stringContaining('wizarr down'),
    )
  })
})

describe('rotateOnce', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('logs what the rotation minted, skipped and reaped', async () => {
    const info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
    vi.mocked(rotateBaselineInvites).mockResolvedValueOnce({
      minted: [{ tier: 'bronze', code: 'a' }],
      skipped: ['gold', 'youth'],
      reaped: ['old'],
    })
    await rotateOnce(bridge)
    expect(info).toHaveBeenCalledWith('baseline rotation: minted 1, skipped gold, youth, reaped 1')
  })

  it('logs a failed rotation rather than letting it escape', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.mocked(rotateBaselineInvites).mockRejectedValueOnce(new Error('boom'))
    await rotateOnce(bridge)
    expect(error).toHaveBeenCalledWith('baseline rotation failed', expect.stringContaining('boom'))
  })
})

describe('startLoops', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  const start = () => {
    const clock = manualTimers(new Date(2026, 8, 27, 1, 0, 0))
    const fetch = vi.fn(async () => ({ users: [] }))
    const snapshot = new UpstreamSnapshot({ fetch })
    const stop = startLoops({
      bridge,
      snapshot,
      reconcileSeconds: 3600,
      snapshotSeconds: 300,
      rotateHour: 3,
      timers: clock.timers,
    })
    return { ...clock, fetch, stop }
  }

  it('sweeps and warms the snapshot at boot, but never rotates at boot', async () => {
    const { fetch, stop } = start()
    await settle()
    expect(checkTierScopes).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(rotateBaselineInvites).not.toHaveBeenCalled()
    stop()
  })

  it('schedules each job on its own clock once its run settles', async () => {
    const { scheduled, stop } = start()
    await settle()
    expect(scheduled.map(({ ms }) => ms).toSorted((a, b) => a - b)).toEqual([
      300 * 1000,
      3600 * 1000,
      2 * 3600 * 1000,
    ])
    stop()
  })

  it('rotates when the hour comes, then waits for the next one', async () => {
    const { scheduled, stop } = start()
    await settle()
    const rotation = scheduled.find(({ ms }) => ms === 2 * 3600 * 1000)
    rotation?.run()
    await settle()
    expect(rotateBaselineInvites).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(4)
    stop()
  })

  it('stops scheduling and clears what is pending when stopped', async () => {
    const { scheduled, stop } = start()
    await settle()
    stop()
    expect(scheduled.every(({ cleared }) => cleared)).toBe(true)
    scheduled[0]?.run()
    await settle()
    expect(scheduled).toHaveLength(3)
  })
})
