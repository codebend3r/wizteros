import { Logger } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LIBRARY_PREFIX_RE,
  TIER_DOWNLOADS,
  YOUTH_LIBRARY_TITLES,
  resolveTierAccess,
  tierScopeProblems,
} from '@/tiers.js'
import { checkTierScopes, resetChangeAlerts } from '@/sweeps.js'
import { asBridge, type FakeBridge, fakeBridge } from '@/test/fakes.js'
import type { WizarrLibrary } from '@/types.js'
import { resolveTierScope } from '@/webhook/handlers.js'

// A healthy live library list: Meleys carries every tier's libraries.
const HEALTHY: readonly WizarrLibrary[] = [
  { id: 23, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 24, name: '02. 4K Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 25, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 26, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 29, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
]

const TIERS = [...TIER_DOWNLOADS.keys()]

/** HEALTHY with every library moved onto a server that is not the share server. */
const movedOffTheShareServer = (): WizarrLibrary[] =>
  HEALTHY.map((lib) => Object.assign({}, lib, { server_name: 'Somewhere Else' }))

describe('tierScopeProblems', () => {
  it('a healthy library list reports no problems', () => {
    expect(tierScopeProblems({ libraries: HEALTHY })).toEqual({})
  })

  it('a tier resolving to zero libraries is reported', () => {
    // This is the youth outage: the allowlist stopped matching any live name,
    // so every youth checkout raised "no libraries resolved" and retried forever.
    const renamed = HEALTHY.filter((lib) => ![25, 26, 29].includes(lib.id))
    const problems = tierScopeProblems({ libraries: renamed })
    expect(problems).toHaveProperty('youth')
    expect(problems.youth).toContain('no libraries')
  })

  it('a partial youth allowlist miss is reported', () => {
    // Youth still resolves, so checkouts succeed — but members silently get a
    // narrower library set than the tier promises. Worth an alert on its own.
    const partial = HEALTHY.filter((lib) => lib.id !== 29)
    const problems = tierScopeProblems({ libraries: partial })
    expect(problems).toHaveProperty('youth')
    expect(problems.youth).toContain('Kid Shows')
  })

  it('renumbering the libraries does not narrow youth', () => {
    // The 2026-08-19 Meleys regroup: the 4K libraries moved to the top, so
    // every "NN. " prefix shifted while the titles stayed put. An allowlist
    // keyed on the full name silently dropped youth from 3 libraries to 1.
    const renumbered = HEALTHY.map((lib) =>
      Object.assign({}, lib, { name: (lib.name ?? '').replace(LIBRARY_PREFIX_RE, `${lib.id}. `) }),
    )
    expect(tierScopeProblems({ libraries: renumbered })).toEqual({})
    const scope = resolveTierAccess({ tier: 'youth', libraries: renumbered })
    expect(scope.library_ids).toHaveLength(YOUTH_LIBRARY_TITLES.size)
  })

  it('an empty library list reports every tier', () => {
    const problems = tierScopeProblems({ libraries: [] })
    expect(new Set(Object.keys(problems))).toEqual(new Set(TIERS))
  })

  it('the share server vanishing reports every entry tier', () => {
    // Meleys renamed or dropped out of Wizarr -> nothing the entry tiers are
    // pinned to is shareable any more, and all three alarm.
    const moved = movedOffTheShareServer()
    const problems = tierScopeProblems({ libraries: moved })
    expect(new Set(Object.keys(problems))).toEqual(new Set(TIERS.filter((tier) => tier !== 'gold')))
  })

  it('gold follows the fleet through a rename instead of alarming', () => {
    // The other half of making gold a denylist: it is not pinned to a name, so
    // a renamed server keeps resolving rather than emptying the tier. Gold only
    // alarms when there is genuinely nothing left to share, which is what
    // "an empty library list reports every tier" covers.
    const moved = movedOffTheShareServer()
    expect(tierScopeProblems({ libraries: moved })).not.toHaveProperty('gold')
    expect(resolveTierAccess({ tier: 'gold', libraries: moved }).server_names).toEqual([
      'Somewhere Else',
    ])
  })

  it('problems are keyed by tier with readable reasons', () => {
    const problems = tierScopeProblems({ libraries: [] })
    expect(Object.values(problems).every((reason) => typeof reason === 'string' && !!reason)).toBe(
      true,
    )
  })
})

// --- the alerting side ------------------------------------------------------
//
// These drive checkTierScopes from sweeps.ts: the alert mail, the
// last-alerted dedupe, and Wizarr being down. The checkout-side
// resolve_tier_scope tests further down live with the bridge's webhook.

/**
 * A bridge with every service faked and the last-alerted state reset.
 *
 * No plex.tv by default: the cache is trusted unless a test says otherwise.
 * The check never opens the store, so the path is never created.
 */
const sweepsBridge = (): FakeBridge => fakeBridge({ dbPath: 'unused.db' })

/** The alert mails sent so far, as { subject, body }. */
const alertsSent = (fake: FakeBridge): { subject: string; body: string }[] =>
  fake.mailer.sendAlert.mock.calls.map(([alert]) => alert)

/** HEALTHY with youth's three allowlist libraries gone. */
const youthBroken = (): WizarrLibrary[] => HEALTHY.filter((lib) => ![25, 26, 29].includes(lib.id))

describe('checkTierScopes', () => {
  // The Python suite reloaded sweeps to reset the last-alerted state.
  beforeEach(() => {
    resetChangeAlerts()
  })

  it('health check alerts when a tier breaks', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue(youthBroken())
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const broken = await checkTierScopes(asBridge(fake))
    const logged = errors.mock.calls.map(([message]) => String(message))
    errors.mockRestore()
    expect(broken).toHaveProperty('youth')
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(alertsSent(fake)[0]?.body).toContain('youth')
    // The stack-health and deploy-nas skills grep the container logs for this line.
    expect(logged.some((line) => line.startsWith('tier scope check: youth -> '))).toBe(true)
  })

  it('health check stays quiet while healthy', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue([...HEALTHY])
    expect(await checkTierScopes(asBridge(fake))).toEqual({})
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  it('health check does not re-alert for an unchanged problem', async () => {
    // The sweep runs hourly; a standing breakage must not mail hourly.
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockImplementation(async () => youthBroken())
    await checkTierScopes(asBridge(fake))
    await checkTierScopes(asBridge(fake))
    await checkTierScopes(asBridge(fake))
    expect(fake.mailer.sendAlert).toHaveBeenCalledTimes(1)
  })

  it('health check re-alerts when the problem changes', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue(youthBroken())
    await checkTierScopes(asBridge(fake))
    fake.wizarr.listLibraries.mockResolvedValue([]) // every tier now broken
    await checkTierScopes(asBridge(fake))
    expect(fake.mailer.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('health check alerts again after a recovery', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue(youthBroken())
    await checkTierScopes(asBridge(fake))
    fake.wizarr.listLibraries.mockResolvedValue([...HEALTHY]) // recovered
    await checkTierScopes(asBridge(fake))
    fake.wizarr.listLibraries.mockResolvedValue(youthBroken())
    await checkTierScopes(asBridge(fake)) // broke again -> alert again
    expect(fake.mailer.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('health check survives wizarr being down', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockRejectedValue(new Error('wizarr down'))
    expect(await checkTierScopes(asBridge(fake))).toEqual({})
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled() // unreachable != misconfigured
  })
})

// --- the wizarr library cache drifting from plex -----------------------------

// Wizarr rows carry the Plex section id as external_id; plex.tv reports the
// same id next to the live title, which is the join the stale check uses.
const CACHED: readonly WizarrLibrary[] = HEALTHY.map((lib) =>
  Object.assign({}, lib, { external_id: `x${lib.id}` }),
)
const LIVE_MELEYS: Readonly<Record<string, string>> = Object.fromEntries(
  HEALTHY.map((lib) => [`x${lib.id}`, lib.name ?? '']),
)
const RENAMED_ON_PLEX = { Meleys: { ...LIVE_MELEYS, x29: '22. Kid Shows' } }

describe('check_tier_scopes and resolve_tier_scope against the Plex cache', () => {
  beforeEach(() => {
    resetChangeAlerts()
  })

  it('health check reports a stale wizarr cache', async () => {
    // The 2026-09-04 bronze signup: Wizarr still said "33. Formula 1", Plex
    // said "22. Formula 1", and every invite carrying the old name was
    // rejected whole at redemption. Neither tier rule nor test could see it.
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue([...CACHED])
    fake.plex.liveSectionsOrNone.mockResolvedValue(RENAMED_ON_PLEX)
    const problems = await checkTierScopes(asBridge(fake))
    expect(problems).toHaveProperty(['wizarr cache on Meleys'])
    expect(problems['wizarr cache on Meleys']).toContain('14. Kid Shows')
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(alertsSent(fake)[0]?.body).toContain('22. Kid Shows')
  })

  it('health check trusts the cache when plex.tv is down', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue([...CACHED])
    fake.plex.liveSectionsOrNone.mockResolvedValue(null)
    expect(await checkTierScopes(asBridge(fake))).toEqual({})
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  it('health check is quiet when the cache matches plex', async () => {
    const fake = sweepsBridge()
    fake.wizarr.listLibraries.mockResolvedValue([...CACHED])
    fake.plex.liveSectionsOrNone.mockResolvedValue({ Meleys: LIVE_MELEYS })
    expect(await checkTierScopes(asBridge(fake))).toEqual({})
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  /** A bridge whose Wizarr cache is CACHED, for the checkout-side scope resolver. */
  const checkoutBridge = (): FakeBridge => {
    const bridge = fakeBridge({ dbPath: 'unused.db' })
    bridge.wizarr.listLibraries.mockResolvedValue([...CACHED])
    return bridge
  }

  it('checkout scope drops a library plex would reject', async () => {
    // The member gets everything Plex will accept instead of nothing.
    const bridge = checkoutBridge()
    bridge.plex.liveSectionsOrNone.mockResolvedValue(RENAMED_ON_PLEX)
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const access = await resolveTierScope({
      bridge: asBridge(bridge),
      tier: 'bronze',
      context: 'checkout cs_test',
    })
    expect(access.library_ids).not.toContain(29)
    expect(access.library_ids).toContain(23)
    expect(error.mock.calls.map(([line]) => String(line)).join('\n')).toContain('14. Kid Shows')
    error.mockRestore()
  })

  it('checkout scope keeps everything when plex.tv is down', async () => {
    const bridge = checkoutBridge()
    bridge.plex.liveSectionsOrNone.mockResolvedValue(null)
    const access = await resolveTierScope({
      bridge: asBridge(bridge),
      tier: 'bronze',
      context: 'checkout cs_test',
    })
    expect(access.library_ids).toContain(29)
  })
})
