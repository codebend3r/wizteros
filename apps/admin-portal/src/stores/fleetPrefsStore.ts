import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** The polling cadences the fleet page offers, slowest reachable by keyboard
    in five steps. Display latency only: readings still arrive at the
    collector's own cadence, so the fastest stop costs requests, never extra
    data. */
export const UPDATE_INTERVAL_STOPS_MS = [100, 500, 1000, 2000, 5000, 10_000] as const

export const DEFAULT_UPDATE_INTERVAL_MS = 1000

const isStop = (value: unknown): value is number =>
  typeof value === 'number' && UPDATE_INTERVAL_STOPS_MS.some((stop) => stop === value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type FleetPrefsState = {
  readonly updateIntervalMs: number
  readonly setUpdateIntervalMs: (intervalMs: number) => void
}

/** The fleet page's own knobs, persisted so a refresh keeps them.

    What comes back from storage is validated against the current stops, not
    trusted: a cadence this build no longer offers - or a hand-edited value -
    must fall back to the default rather than drive the poll loop at an
    arbitrary rate. */
export const useFleetPrefsStore = create<FleetPrefsState>()(
  persist(
    (set) => ({
      updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
      setUpdateIntervalMs: (intervalMs) =>
        set({ updateIntervalMs: isStop(intervalMs) ? intervalMs : DEFAULT_UPDATE_INTERVAL_MS }),
    }),
    {
      name: 'wz-fleet-prefs',
      merge: (persisted, current) => {
        const stored = isRecord(persisted) ? persisted.updateIntervalMs : undefined
        return { ...current, updateIntervalMs: isStop(stored) ? stored : current.updateIntervalMs }
      },
    },
  ),
)
