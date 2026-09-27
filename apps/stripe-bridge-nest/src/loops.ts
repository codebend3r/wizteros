import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { MEMBERS_SNAPSHOT } from '@/admin/membersSnapshot.js'
import { rotateBaselineInvites } from '@/baseline.js'
import { BRIDGE } from '@/bridgeToken.js'
import {
  baselineRotateHour,
  membersSnapshotIntervalSeconds,
  reconcileIntervalSeconds,
} from '@/config.js'
import { reconcilePendingExpiries } from '@/reconcile.js'
import type { UpstreamSnapshot } from '@/snapshot.js'
import { checkPaymentStates, checkTierScopes, checkVipAccess } from '@/sweeps.js'
import type { Bridge } from '@/types.js'

// The three jobs the bridge runs between webhooks, each on its own clock:
// the reconcile sweep (drift alarms plus the expiry stamp) every
// RECONCILE_INTERVAL_SECONDS, the members snapshot every
// MEMBERS_SNAPSHOT_INTERVAL_SECONDS, and the baseline rotation once a day at
// BASELINE_ROTATE_HOUR local time. The Python bridge ran them as asyncio
// tasks; here each is a chain of timers, rescheduled only after its run
// settles, so a slow Wizarr can delay a job but never stack two of it.

const log = new Logger('bridge')

/** Python's `%s` of a list of strings, for the rotation log line. */
const pyList = (items: readonly string[]): string =>
  `[${items.map((item) => `'${item}'`).join(', ')}]`

/** Run one job, logging a failure with its stack instead of letting it escape. */
const guarded = async ({ label, run }: { label: string; run: () => Promise<unknown> }) => {
  try {
    await run()
  } catch (error) {
    log.error(label, error instanceof Error ? error.stack : String(error))
  }
}

/**
 * Milliseconds from `now` until the next local occurrence of `hour`:00.
 *
 * Sleeping to a wall-clock target rather than on a fixed interval keeps the
 * rotation pinned to the same time every day instead of drifting forward by
 * however long each run took, and re-anchors it after a restart. The Python
 * computed this on naive local datetimes, which ignored a DST change falling
 * inside the wait; setDate moves the wall clock, so the rotation keeps its
 * hour across one.
 */
export const msUntilHour = ({ hour, now }: { hour: number; now: Date }): number => {
  const target = new Date(now)
  target.setHours(hour, 0, 0, 0)
  if (target <= now) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime() - now.getTime()
}

/**
 * Run the alarms and the expiry sweep once.
 *
 * The checks run first and independently of each other: they are the drift
 * alarms, so each must still fire on a sweep where another pass throws.
 */
export const reconcileOnce = async (bridge: Bridge): Promise<void> => {
  await guarded({ label: 'tier scope check failed', run: () => checkTierScopes(bridge) })
  await guarded({ label: 'vip access check failed', run: () => checkVipAccess(bridge) })
  await guarded({ label: 'payment state check failed', run: () => checkPaymentStates(bridge) })
  await guarded({
    label: 'expiry reconcile sweep failed',
    run: () => reconcilePendingExpiries(bridge),
  })
}

/** Rotate the per-tier baseline invites once, logging what happened. */
export const rotateOnce = async (bridge: Bridge): Promise<void> =>
  guarded({
    label: 'baseline rotation failed',
    run: async () => {
      const { minted, skipped, reaped } = await rotateBaselineInvites({ bridge })
      log.log(
        `baseline rotation: minted ${minted.length}, skipped ${skipped.length > 0 ? pyList(skipped) : 'none'}, reaped ${reaped.length}`,
      )
    },
  })

export type Timers = Readonly<{
  setTimeout: (run: () => void, ms: number) => NodeJS.Timeout
  clearTimeout: (timer: NodeJS.Timeout) => void
  now: () => Date
}>

const SYSTEM_TIMERS: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => new Date(),
}

/**
 * Start the three loops and return a function that stops them.
 *
 * The reconcile sweep and the snapshot run immediately, then on their
 * intervals. The rotation deliberately does not run at boot: a restart loop
 * would otherwise mint a fresh set of invites every time the container came
 * up. A failed snapshot refresh (Wizarr or plex.tv down) logs and retries next
 * interval; /admin/members keeps serving the previous snapshot meanwhile.
 */
export const startLoops = ({
  bridge,
  snapshot,
  reconcileSeconds,
  snapshotSeconds,
  rotateHour,
  timers = SYSTEM_TIMERS,
}: {
  bridge: Bridge
  snapshot: UpstreamSnapshot<unknown>
  reconcileSeconds: number
  snapshotSeconds: number
  rotateHour: number
  timers?: Timers
}): (() => void) => {
  const pending = new Set<NodeJS.Timeout>()
  const state = { stopped: false }

  const schedule = ({ ms, run }: { ms: number; run: () => Promise<void> }): void => {
    if (state.stopped) {
      return
    }
    const timer = timers.setTimeout(() => {
      pending.delete(timer)
      void run()
    }, ms)
    pending.add(timer)
  }

  const reconcile = async (): Promise<void> => {
    await reconcileOnce(bridge)
    schedule({ ms: reconcileSeconds * 1000, run: reconcile })
  }

  const refreshSnapshot = async (): Promise<void> => {
    await guarded({ label: 'members snapshot refresh failed', run: () => snapshot.refresh() })
    schedule({ ms: snapshotSeconds * 1000, run: refreshSnapshot })
  }

  const rotate = async (): Promise<void> => {
    await rotateOnce(bridge)
    schedule({ ms: msUntilHour({ hour: rotateHour, now: timers.now() }), run: rotate })
  }

  void reconcile()
  void refreshSnapshot()
  schedule({ ms: msUntilHour({ hour: rotateHour, now: timers.now() }), run: rotate })

  return () => {
    state.stopped = true
    pending.forEach((timer) => timers.clearTimeout(timer))
    pending.clear()
  }
}

/** Starts the loops once the app is up, and stops them when it shuts down. */
@Injectable()
export class BackgroundLoops implements OnApplicationBootstrap, OnApplicationShutdown {
  private stop: (() => void) | null = null

  constructor(
    @Inject(BRIDGE) private readonly bridge: Bridge,
    @Inject(MEMBERS_SNAPSHOT) private readonly snapshot: UpstreamSnapshot<unknown>,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = startLoops({
      bridge: this.bridge,
      snapshot: this.snapshot,
      reconcileSeconds: reconcileIntervalSeconds(),
      snapshotSeconds: membersSnapshotIntervalSeconds(),
      rotateHour: baselineRotateHour(),
    })
  }

  onApplicationShutdown(): void {
    this.stop?.()
    this.stop = null
  }
}
