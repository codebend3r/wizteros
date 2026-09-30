import { describe, expect, it } from 'vitest'
import { parseLoadavg, parseMeminfo, parseNetDev, parseStat, parseUptime } from '@/probes/proc.js'
import type { Sample } from '@/probes/types.js'
import { fixtureText } from '@/test/support.js'

const byMetric = (samples: readonly Sample[]): Record<string, number> =>
  Object.fromEntries(samples.map((sample) => [sample.metric, sample.value]))

describe('parseStat', () => {
  it('emits per-core and total counters', () => {
    const text = fixtureText('caraxes_proc_stat.txt')
    const got = byMetric(parseStat(text))

    expect(got['cpu.total.user']).toBe(31815)
    expect(got['cpu.total.idle']).toBe(682370)
    expect(got['cpu.total.iowait']).toBe(11506)
    expect(got['cpu0.user']).toBe(8189)
    expect(got['cpu3.idle']).toBe(171007)
    // 5 cpu lines x 8 tracked fields
    expect(parseStat(text)).toHaveLength(40)
    expect(parseStat(text).every((sample) => sample.kind === 'counter')).toBe(true)
  })
})

describe('parseMeminfo', () => {
  it('converts kB to bytes', () => {
    const text = fixtureText('caraxes_proc_meminfo.txt')
    const got = byMetric(parseMeminfo(text))

    expect(got['mem.total_bytes']).toBe(1683776 * 1024)
    expect(got['mem.available_bytes']).toBe(605812 * 1024)
    expect(got['mem.cached_bytes']).toBe(624132 * 1024)
    // swap sits at lines 15 and 16 of a real aarch64 /proc/meminfo, which is
    // exactly what `head -n 16` in VITALS_SCRIPT is sized for
    expect(got['mem.swap_total_bytes']).toBe(2097084 * 1024)
    expect(got['mem.swap_free_bytes']).toBe(2094876 * 1024)
    expect(parseMeminfo(text).every((sample) => sample.kind === 'gauge')).toBe(true)
  })
})

describe('parseNetDev', () => {
  it('skips loopback and tunnels', () => {
    const text = fixtureText('caraxes_proc_net_dev.txt')
    const got = byMetric(parseNetDev(text))

    expect(got['net.eth1.rx_bytes']).toBe(15298811)
    expect(got['net.eth1.tx_bytes']).toBe(12733181)
    expect(got).not.toHaveProperty(['net.lo.rx_bytes'])
    expect(got).not.toHaveProperty(['net.sit0.rx_bytes'])
  })

  it('skips docker bridges', () => {
    // vermithor carries 11 docker* interfaces; they are noise, not fleet traffic
    const text =
      'Inter-|   Receive  |  Transmit\n' +
      ' face |bytes ...\n' +
      '  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n' +
      '  docker0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n' +
      '  docker41a7c36: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n'
    const got = byMetric(parseNetDev(text))

    expect(got).toEqual({ 'net.eth0.rx_bytes': 100, 'net.eth0.tx_bytes': 200 })
  })

  it('skips per-container interfaces', () => {
    // every running container creates a veth<hex> whose name changes on every
    // restart, so each one is written exactly once and never again. Sampling
    // them pins the oldest-metric age of a healthy docker host at "forever".
    const text =
      'Inter-|   Receive  |  Transmit\n' +
      ' face |bytes ...\n' +
      '  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n' +
      '  veth8a3f21: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n' +
      '  br-1f2e3d4c5b6a: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n'
    const got = byMetric(parseNetDev(text))

    expect(got).toEqual({ 'net.eth0.rx_bytes': 100, 'net.eth0.tx_bytes': 200 })
  })

  it('skips VPN tunnels', () => {
    // meleys, 2026-08-26: DSM's VPN Server brought up a tun1000 for one hour,
    // and its two counters froze the moment it went away. Same class as veth,
    // and doubly so: tunnelled bytes cross a physical NIC as well, so counting
    // the tunnel counts them twice while it lives and lies afterwards.
    const text =
      'Inter-|   Receive  |  Transmit\n' +
      ' face |bytes ...\n' +
      '  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n' +
      '  tun1000: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n' +
      '  tap0: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n' +
      '  wg0: 700 7 0 0 0 0 0 0 800 8 0 0 0 0 0 0\n'
    const got = byMetric(parseNetDev(text))

    expect(got).toEqual({ 'net.eth0.rx_bytes': 100, 'net.eth0.tx_bytes': 200 })
  })

  it('keeps a PPPoE uplink', () => {
    // ppp is deliberately not in the skip list: on a box speaking PPPoE it is
    // the real uplink, not a tunnel over one, and dropping it would lose the
    // only interface that carries the box's traffic.
    const text =
      'Inter-|   Receive  |  Transmit\n' +
      ' face |bytes ...\n' +
      '  ppp0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n'
    const got = byMetric(parseNetDev(text))

    expect(got).toEqual({ 'net.ppp0.rx_bytes': 100, 'net.ppp0.tx_bytes': 200 })
  })
})

describe('parseLoadavg', () => {
  it('reads the load averages and the process counts', () => {
    const got = byMetric(parseLoadavg('0.20 0.18 0.12 1/721 21708\n'))

    expect(got['load.1m']).toBe(0.2)
    expect(got['load.5m']).toBe(0.18)
    expect(got['load.15m']).toBe(0.12)
    expect(got['procs.running']).toBe(1)
    expect(got['procs.total']).toBe(721)
  })
})

describe('parseUptime', () => {
  it('reads the seconds since boot', () => {
    const got = byMetric(parseUptime('950412.67 3698765.43\n'))

    expect(got['uptime.seconds']).toBe(950412.67)
  })
})

describe('the proc parsers', () => {
  it('skip non-numeric values instead of raising', () => {
    // /proc is read over ssh and arrives as unvalidated text; one malformed
    // token reaching a parse raises out of the parser and costs the whole
    // host's round
    const stat = byMetric(parseStat('cpu  100 nan 50 900 0 0 0 0\ncpu0 x y z\n'))
    expect(stat['cpu.total.user']).toBe(100)
    expect(stat).not.toHaveProperty(['cpu.total.nice'])
    expect(stat['cpu.total.system']).toBe(50)
    expect(Object.keys(stat).some((metric) => metric.startsWith('cpu0.'))).toBe(false)

    expect(parseMeminfo('MemTotal:  not-a-number kB\n')).toEqual([])
    expect(parseNetDev('h1\nh2\n  eth0: x 1 0 0 0 0 0 0 y 2 0 0 0 0 0 0\n')).toEqual([])
    expect(parseLoadavg('0.20 nope 0.12 1/721 21708\n')).toEqual([])
    expect(parseUptime('not-a-number 3698765.43\n')).toEqual([])
  })

  it('are total on empty input', () => {
    // a truncated tick must yield nothing, never raise: one bad host cannot
    // be allowed to kill a collection round
    expect(parseStat('')).toEqual([])
    expect(parseMeminfo('')).toEqual([])
    expect(parseNetDev('')).toEqual([])
    expect(parseLoadavg('')).toEqual([])
    expect(parseUptime('')).toEqual([])
  })
})
