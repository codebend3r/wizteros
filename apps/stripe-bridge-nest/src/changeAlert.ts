import type { Alert, Mailer } from '@/types.js'

// An alarm that mails once per distinct problem set, not once per sweep.

/**
 * A structural key for a problem set, so two equal sets compare equal
 * whatever order their object keys were built in.
 */
const canonicalKey = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  )

/**
 * Mails once per distinct problem set, not once per sweep.
 *
 * A standing breakage is alerted on the sweep that finds it and then stays
 * quiet; a change in the set, or a recovery followed by a relapse, alerts
 * again. The remembered set lives as long as the alarm does: the loop keeps
 * one for the life of the process, so a restart re-alerts on whatever is
 * still broken.
 */
export class ChangeAlert {
  // Nothing outstanding to start with, so the first problem set always mails.
  private last: string | null = null

  /** Forget the outstanding set: the same problem returning mails again. */
  clear(): void {
    this.last = null
  }

  /** Mail the alert unless this exact set is the one already alerted on. */
  async fire({
    current,
    alert,
    mailer,
  }: {
    current: unknown
    alert: Alert
    mailer: Mailer
  }): Promise<void> {
    const key = canonicalKey(current)
    if (key !== this.last) {
      this.last = key
      await mailer.sendAlert(alert)
    }
  }
}

/** The two alarms the reconcile sweep keeps for the life of the process. */
export type SweepAlerts = Readonly<{ tierScope: ChangeAlert; vipAccess: ChangeAlert }>

/** Fresh alarms with nothing outstanding, so the first problem set mails. */
export const sweepAlerts = (): SweepAlerts => ({
  tierScope: new ChangeAlert(),
  vipAccess: new ChangeAlert(),
})
