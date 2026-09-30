import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpstreamSnapshot } from '@/snapshot.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UpstreamSnapshot', () => {
  it('get fetches once then serves the cached value', async () => {
    const calls: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        calls.push(1)
        return { n: calls.length }
      },
    })
    expect(await snap.get()).toEqual({ n: 1 })
    expect(await snap.get()).toEqual({ n: 1 })
    expect(calls).toHaveLength(1)
  })

  it('refresh replaces the value', async () => {
    const calls: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        calls.push(1)
        return calls.length
      },
    })
    expect(await snap.get()).toBe(1)
    expect(await snap.refresh()).toBe(2)
    expect(await snap.get()).toBe(2)
  })

  it('clear forces a refetch', async () => {
    const calls: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        calls.push(1)
        return calls.length
      },
    })
    expect(await snap.get()).toBe(1)
    snap.clear()
    expect(await snap.get()).toBe(2)
  })

  it('refresh propagates fetch failures', async () => {
    const snap = new UpstreamSnapshot<number>({
      fetch: async () => {
        throw new Error('wizarr down')
      },
    })
    await expect(snap.refresh()).rejects.toThrow('wizarr down')
  })

  it('a refreshAsync failure keeps serving the previous value', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const fetches: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        fetches.push(1)
        if (fetches.length > 1) {
          throw new Error('wizarr down')
        }
        return 'first'
      },
    })
    expect(await snap.get()).toBe('first')
    snap.refreshAsync()
    await snap.settled()
    expect(fetches).toHaveLength(2)
    expect(snap.refreshing).toBe(false)
    expect(await snap.get()).toBe('first')
    expect(String(error.mock.calls[0]?.[0])).toContain('background snapshot refresh failed')
  })

  it('refreshAsync updates the value', async () => {
    const fetches: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        fetches.push(1)
        return fetches.length
      },
    })
    expect(await snap.get()).toBe(1)
    snap.refreshAsync()
    await snap.settled()
    expect(fetches).toHaveLength(2)
    expect(snap.refreshing).toBe(false)
    expect(await snap.get()).toBe(2)
  })

  it('refreshAsync is a no-op while a refresh is in flight', async () => {
    const fetches: number[] = []
    const snap = new UpstreamSnapshot({
      fetch: async () => {
        fetches.push(1)
        return fetches.length
      },
    })
    snap.refreshAsync()
    snap.refreshAsync()
    expect(snap.refreshing).toBe(true)
    await snap.settled()
    expect(fetches).toHaveLength(1)
  })
})
