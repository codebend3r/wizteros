import { Logger } from '@nestjs/common'
import { dunningSweep, type DunningFinding, tierScopes, vipsWithoutAccess } from '@/alerts.js'
import { accessLine } from '@/members.js'
import { mapInOrder } from '@/sequence.js'
import { holdsStandingGrant } from '@/standing.js'
import { statusRule, stripeStatusByCustomer } from '@/subscriptionStatus.js'
import { libraryCacheProblems, tierScopeProblems } from '@/tiers.js'
import type { Alert, Bridge, Mailer, WizarrUser } from '@/types.js'
import { stackOf } from '@/errors.js'

// The drift alarms the reconcile loop runs between webhooks.
//
// Each check never throws, alerts once per new problem rather than every
// sweep, and never touches a member's access: that stays with the webhook
// handlers. They take the bridge as their argument so the loop, the tests,
// and any one-off script call them the same way.

const log = new Logger('bridge')

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
 * again. The remembered set lives for the life of the process, so a restart
 * re-alerts on whatever is still broken.
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

const tierScopeAlert = new ChangeAlert()
const vipAccessAlert = new ChangeAlert()

/**
 * Forget what both alarms last mailed about.
 *
 * The Python suites reloaded the module between tests to get this; the
 * process-long state is otherwise only reset by a restart.
 */
export const resetChangeAlerts = (): void => {
  tierScopeAlert.clear()
  vipAccessAlert.clear()
}

/**
 * Mirror Stripe's own dunning state onto the store; alert on what the webhooks missed.
 *
 * invoice.payment_failed only reaches the bridge when Stripe delivers it, and
 * a member found past due by this sweep is one whose failure arrived by no
 * other route: the event type was not enabled, the Funnel was down, the
 * retries ran out. Access is never touched here; that stays the cancel
 * handler's job. Alerts once per newly found member, because writing the
 * flag is what stops the next sweep repeating it. Never throws: an
 * unreachable Stripe is not a missed payment.
 */
export const checkPaymentStates = async (bridge: Bridge): Promise<string[]> => {
  const byCustomer = await stripeStatusByCustomer(bridge.stripe).catch((error: unknown) => {
    log.error('payment state check: could not list subscriptions from Stripe', stackOf(error))
    return null
  })
  if (byCustomer === null) return []
  const outcomes = await mapInOrder({
    items: [...bridge.store.allCustomerRows().entries()],
    run: async ([email, row]): Promise<DunningFinding | null> => {
      const status = row.customer_id === null ? undefined : byCustomer.get(row.customer_id)
      const rule = status === undefined ? undefined : statusRule(status)
      if (!row.subscribed || status === undefined || rule === undefined) {
        return null
      }
      const state = rule.paymentState
      if (state === row.payment_state) return null
      bridge.store.setPaymentState({ email, state })
      if (state) {
        log.warn(`payment state check: ${email} is ${status} in Stripe; no webhook said so`)
        bridge.store.recordEvent({
          email,
          action: 'Payment failed',
          detail:
            `Stripe reports the subscription ${status}; found by the sweep, ` +
            `no webhook was received`,
        })
        const line = await accessLine({ bridge, customerId: row.customer_id, email })
        return { email, status, line }
      }
      log.log(`payment state check: ${email} is paying again`)
      bridge.store.recordEvent({
        email,
        action: 'Payment recovered',
        detail: 'Stripe reports the subscription active again',
      })
      return null
    },
  })
  const found = outcomes.filter((finding): finding is DunningFinding => finding !== null)
  if (found.length > 0) {
    await bridge.mailer.sendAlert(dunningSweep(found))
  }
  return found.map(({ email }) => email)
}

/**
 * VIPs holding no Wizarr record at all; alert on the set changing.
 *
 * A VIP is a standing grant, so "no records" is never a normal resting state
 * for one: it means an invite was issued and never redeemed, or something
 * disabled them. Guards stop the causes the bridge knows about, and this is
 * the net under the ones it does not (a manual disable, a Plex-side unshare,
 * an invite that quietly expired). Never throws: it runs inside the reconcile
 * loop, and an unreachable Wizarr is not a lockout.
 */
export const checkVipAccess = async (bridge: Bridge): Promise<string[]> => {
  const tags = bridge.store.allMemberTags()
  const vips = [...tags.entries()]
    .filter(([, tag]) => holdsStandingGrant(tag))
    .map(([email]) => email)
    .toSorted()
  if (vips.length === 0) {
    vipAccessAlert.clear()
    return []
  }
  const users = await bridge.wizarr.listUsers().catch((error: unknown): WizarrUser[] | null => {
    log.error('vip access check: could not read users from Wizarr', stackOf(error))
    return null
  })
  if (users === null) return []
  const held = new Set(users.map((user) => (user.email ?? '').toLowerCase()))
  const stranded = vips.filter((email) => !held.has(email))
  if (stranded.length === 0) {
    vipAccessAlert.clear()
    return []
  }
  log.error(`vip access check: ${stranded.length} VIP(s) hold no records: ${stranded.join(', ')}`)
  await vipAccessAlert.fire({
    current: stranded,
    alert: vipsWithoutAccess(stranded),
    mailer: bridge.mailer,
  })
  return stranded
}

/**
 * Verify every tier still resolves against the live library list; alert on drift.
 *
 * The tier rules match Plex library names, so a rename on the server silently
 * empties a tier with no code change and no failing test — that is exactly how
 * the youth tier died unnoticed. The same rename also leaves a stale name in
 * Wizarr's own library cache until someone rescans it, and Plex rejects every
 * invite carrying that name whole at redemption, so the cache is checked
 * against plex.tv's live sections here too. Returns the problems found
 * (empty when healthy). Never throws: it runs inside the reconcile loop, and
 * neither a down Wizarr nor a down SMTP may take that loop out. A Wizarr or
 * plex.tv that cannot be reached is reported as healthy — unreachable is not
 * misconfigured, and the next sweep will try again.
 */
export const checkTierScopes = async (bridge: Bridge): Promise<Record<string, string>> => {
  const libraries = await bridge.wizarr.listLibraries().catch((error: unknown) => {
    log.error('tier scope check: could not read libraries from Wizarr', stackOf(error))
    return null
  })
  if (libraries === null) return {}
  const problems: Record<string, string> = {
    ...tierScopeProblems({ libraries }),
    ...libraryCacheProblems({ libraries, live: await bridge.plex.liveSectionsOrNone() }),
  }
  if (Object.keys(problems).length === 0) {
    tierScopeAlert.clear()
    return {}
  }
  Object.entries(problems).forEach(([tier, reason]) => {
    log.error(`tier scope check: ${tier} -> ${reason}`)
  })
  await tierScopeAlert.fire({
    current: problems,
    alert: tierScopes(problems),
    mailer: bridge.mailer,
  })
  return problems
}
