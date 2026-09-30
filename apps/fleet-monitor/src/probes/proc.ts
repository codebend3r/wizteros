import { number } from '@/probes/parse.js'
import type { Sample } from '@/probes/types.js'

// /proc/stat orders these fields after the cpu label. Trailing guest fields are
// ignored: they are already counted inside user and nice. Public because cpu
// derives the metric names it reads back from this same list: what the busy
// derivation sums is defined by what parseStat writes, in one place.
export const CPU_FIELDS = [
  'user',
  'nice',
  'system',
  'idle',
  'iowait',
  'irq',
  'softirq',
  'steal',
] as const

// Values are in kB. Anything not listed here is not worth a row per tick.
// Exported for the script test, which checks that `head -n N` in the vitals
// script reaches every one of these keys in a real /proc/meminfo.
export const MEM_KEYS: ReadonlyMap<string, string> = new Map([
  ['MemTotal', 'mem.total_bytes'],
  ['MemFree', 'mem.free_bytes'],
  ['MemAvailable', 'mem.available_bytes'],
  ['Buffers', 'mem.buffers_bytes'],
  ['Cached', 'mem.cached_bytes'],
  ['SwapTotal', 'mem.swap_total_bytes'],
  ['SwapFree', 'mem.swap_free_bytes'],
])

const SKIP_IFACES: ReadonlySet<string> = new Set(['lo', 'sit0'])

// Per-container, bridge and tunnel interfaces. veth is the one that matters:
// every running container creates a veth<hex> whose name changes on every
// restart, so each one is written exactly once and never again. Kept out of the
// samples entirely, because a metric that stops being produced the moment it
// appears poisons every staleness signal derived from metric timestamps.
//
// tun/tap/wg are the same class, learned the same way: DSM's VPN Server brought
// up a tun1000 on meleys for one hour on 2026-08-26, and its two frozen
// counters then reported the host stale for the rest of the day. They are also
// double counting even while they live, since tunnelled bytes cross a physical
// NIC as well, and this section is about what enters and leaves the box.
//
// ppp is deliberately not here: on a box speaking PPPoE it is the real uplink,
// not a tunnel over one.
const SKIP_PREFIXES: readonly string[] = ['docker', 'veth', 'br-', 'tun', 'tap', 'wg']

// Byte columns in /proc/net/dev after the interface name: receive starts at 0,
// transmit at 8 (each half is bytes packets errs drop fifo frame compressed
// multicast).
const RX_BYTES = 0
const TX_BYTES = 8

// Text helpers shared with probes/system, standing in for the Python string
// methods both parsers lean on. They are exported from here rather than
// probes/parse only because that module was written before this port.

// Python's str.splitlines(): no empty line after a trailing break. It also
// breaks on a handful of control and Unicode separators that /proc never
// prints, so the three real line endings are enough here.
export const lines = (text: string): readonly string[] => {
  const parts = text.split(/\r\n|\n|\r/)
  return parts.at(-1) === '' ? parts.slice(0, -1) : parts
}

// Python's str.split() with no argument: runs of whitespace, no empty words.
export const words = (text: string): readonly string[] =>
  text.split(/\s+/).filter((word) => word !== '')

// Python's str.split(separator, 1): everything before the first separator, and
// everything after it when there is one.
export const splitOnce = ({
  text,
  separator,
}: {
  text: string
  separator: string
}): readonly [string, string] | readonly [string] => {
  const at = text.indexOf(separator)
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + separator.length)]
}

/** Per-core and aggregate CPU jiffy counters from /proc/stat. */
export const parseStat = (text: string): readonly Sample[] =>
  lines(text)
    .filter((line) => line.startsWith('cpu'))
    .map(words)
    .flatMap((row) => {
      const label = row[0] === 'cpu' ? 'cpu.total' : row[0]
      return CPU_FIELDS.flatMap((field, index): readonly Sample[] => {
        const value = index + 1 < row.length ? number(row[index + 1]) : null
        return value === null ? [] : [{ metric: `${label}.${field}`, value, kind: 'counter' }]
      })
    })

/** Memory gauges from /proc/meminfo, converted from kB to bytes. */
export const parseMeminfo = (text: string): readonly Sample[] =>
  lines(text)
    .filter((line) => line.includes(':'))
    .flatMap((line): readonly Sample[] => {
      const [key, rest = ''] = splitOnce({ text: line, separator: ':' })
      const metric = MEM_KEYS.get(key)
      const [first] = words(rest)
      const kilobytes = first === undefined ? null : number(first)
      return metric === undefined || kilobytes === null
        ? []
        : [{ metric, value: kilobytes * 1024, kind: 'gauge' }]
    })

/**
 * Per-interface byte counters, minus loopback, tunnels and container
 * plumbing.
 *
 * The docker* bridges are skipped because vermithor alone carries eleven of
 * them and none of them describe traffic entering or leaving the box. veth*
 * and br-* go with them: they are per-container, and a veth name changes on
 * every container restart.
 */
export const parseNetDev = (text: string): readonly Sample[] =>
  lines(text)
    .slice(2)
    .filter((line) => line.includes(':'))
    .flatMap((line): readonly Sample[] => {
      const [head, rest = ''] = splitOnce({ text: line, separator: ':' })
      const name = head.trim()
      const fields = words(rest)
      if (
        SKIP_IFACES.has(name) ||
        SKIP_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        fields.length <= TX_BYTES
      ) {
        return []
      }
      const received = number(fields[RX_BYTES])
      const sent = number(fields[TX_BYTES])
      return received === null || sent === null
        ? []
        : [
            { metric: `net.${name}.rx_bytes`, value: received, kind: 'counter' },
            { metric: `net.${name}.tx_bytes`, value: sent, kind: 'counter' },
          ]
    })

const LOAD_METRICS = ['load.1m', 'load.5m', 'load.15m', 'procs.running', 'procs.total'] as const

const isNumber = (value: number | null): value is number => value !== null

/** Load averages and the runnable/total process counts from /proc/loadavg. */
export const parseLoadavg = (text: string): readonly Sample[] => {
  const fields = words(text)
  if (fields.length < 4 || !fields[3].includes('/')) {
    return []
  }
  const [running, total = ''] = splitOnce({ text: fields[3], separator: '/' })
  const values = [...fields.slice(0, 3), running, total].map(number)
  // one malformed column makes the whole line untrustworthy: it is a single
  // reading of one file, not five independent ones
  if (!values.every(isNumber)) {
    return []
  }
  return LOAD_METRICS.map((metric, index): Sample => ({
    metric,
    value: values[index],
    kind: 'gauge',
  }))
}

/**
 * Seconds since boot from /proc/uptime.
 *
 * Read from /proc rather than the uptime command because the DSM uptime
 * output carries Synology's own IO and CPU suffixes, which shift the columns.
 */
export const parseUptime = (text: string): readonly Sample[] => {
  const [first] = words(text)
  const seconds = first === undefined ? null : number(first)
  return seconds === null ? [] : [{ metric: 'uptime.seconds', value: seconds, kind: 'gauge' }]
}
