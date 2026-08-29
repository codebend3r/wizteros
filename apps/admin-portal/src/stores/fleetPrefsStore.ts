import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MetricKind } from '@/lib/fleetApi'

/** The polling cadences the fleet page offers, slowest reachable by keyboard
    in five steps. Display latency only: readings still arrive at the
    collector's own cadence, so the fastest stop costs requests, never extra
    data. */
export const UPDATE_INTERVAL_STOPS_MS = [100, 500, 1000, 2000, 5000, 10_000] as const

export const DEFAULT_UPDATE_INTERVAL_MS = 1000

/** How far back the CPU chart looks, widest first.

    A week is the ceiling because raw samples live seven days on the monitor
    before pruning, so a wider range could only ever answer with less. The
    monitor buckets anything too wide to draw on the way out, which is why a
    week costs a bigger query but not a bigger payload. */
export const CPU_RANGES = [
  { minutes: 10_080, label: '1 week', prose: 'week' },
  { minutes: 4_320, label: '3 days', prose: '3 days' },
  { minutes: 1_440, label: '1 day', prose: 'day' },
  { minutes: 720, label: '12 hours', prose: '12 hours' },
  { minutes: 360, label: '6 hours', prose: '6 hours' },
  { minutes: 60, label: '1 hour', prose: 'hour' },
  { minutes: 15, label: '15 minutes', prose: '15 minutes' },
] as const

export const DEFAULT_RANGE_MINUTES = 60

/** One tab per chart, in the order they are offered. CPU leads because it is
    the one that moves; GPU trails because three of the five boxes can never
    answer it. */
export const CHART_KINDS = ['cpu', 'memory', 'network', 'gpu'] as const

export const DEFAULT_CHART_KIND: MetricKind = 'cpu'

/** A range as it reads mid-sentence, so the chart's prose names the same span
    the pressed button does without saying "the last 1 hour". Falls back to the
    raw count for a value that is not a range, which only the guards below
    should ever let through. */
export const rangeProse = (minutes: number): string =>
  CPU_RANGES.find((range) => range.minutes === minutes)?.prose ?? `${minutes} minutes`

const isStop = (value: unknown): value is number =>
  typeof value === 'number' && UPDATE_INTERVAL_STOPS_MS.some((stop) => stop === value)

const isRange = (value: unknown): value is number =>
  typeof value === 'number' && CPU_RANGES.some((range) => range.minutes === value)

const isChartKind = (value: unknown): value is MetricKind =>
  CHART_KINDS.some((kind) => kind === value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type FleetPrefsState = {
  readonly updateIntervalMs: number
  readonly setUpdateIntervalMs: (intervalMs: number) => void
  readonly rangeMinutes: number
  readonly setRangeMinutes: (minutes: number) => void
  /** Which chart the tabs are showing. Only this one polls, so the page costs
      one request per interval however many charts exist. */
  readonly chartKind: MetricKind
  readonly setChartKind: (kind: MetricKind) => void
}

/** The fleet page's own knobs, persisted so a refresh keeps them.

    What comes back from storage is validated against the current stops, not
    trusted: a cadence this build no longer offers - or a hand-edited value -
    must fall back to the default rather than drive the poll loop at an
    arbitrary rate. The same holds for the range, which the monitor would
    refuse outright past its own ceiling. */
export const useFleetPrefsStore = create<FleetPrefsState>()(
  persist(
    (set) => ({
      updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
      setUpdateIntervalMs: (intervalMs) =>
        set({ updateIntervalMs: isStop(intervalMs) ? intervalMs : DEFAULT_UPDATE_INTERVAL_MS }),
      rangeMinutes: DEFAULT_RANGE_MINUTES,
      setRangeMinutes: (minutes) =>
        set({ rangeMinutes: isRange(minutes) ? minutes : DEFAULT_RANGE_MINUTES }),
      chartKind: DEFAULT_CHART_KIND,
      setChartKind: (kind) => set({ chartKind: isChartKind(kind) ? kind : DEFAULT_CHART_KIND }),
    }),
    {
      name: 'wz-fleet-prefs',
      merge: (persisted, current) => {
        const stored = isRecord(persisted) ? persisted : {}
        return {
          ...current,
          updateIntervalMs: isStop(stored.updateIntervalMs)
            ? stored.updateIntervalMs
            : current.updateIntervalMs,
          rangeMinutes: isRange(stored.rangeMinutes) ? stored.rangeMinutes : current.rangeMinutes,
          chartKind: isChartKind(stored.chartKind) ? stored.chartKind : current.chartKind,
        }
      },
    },
  ),
)
