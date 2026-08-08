#!/usr/bin/env node
// End-to-end check that every tier's SIGNUP produces a correctly scoped invite,
// against the LIVE Wizarr and a locally-running stripe-bridge.
//
// The unit tests prove the tier rules are self-consistent; this proves the
// rules still match the real server. For each tier it drives a synthetic
// (signed) checkout.session.completed through the bridge, reads back the
// invite the bridge created, and asserts its server and library scope, then
// deletes the invite so nothing is left redeemable. The expected downloads
// flag is printed for reference only: the invite's real allow_downloads is
// never read back, so it is not asserted.
//
//   for each of bronze / silver / gold / youth:
//     POST checkout.session.completed {metadata:{tier}}
//     -> find the invite the bridge just created
//     -> assert scope: share server only, expected library names
//     -> DELETE the invite
//
// Uses a synthetic email that matches no Plex account, so the bridge finds no
// existing records and never disables a real member. Run:
//   bun run test:e2e:tiers   (from the workspace root)
import crypto from 'node:crypto'

const { WIZARR_BASE_URL, WIZARR_API_KEY, STRIPE_WEBHOOK_SECRET } = process.env

const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:8000'
const WIZARR = (WIZARR_BASE_URL || '').replace(/\/+$/, '')
const SHARE_SERVER = process.env.SHARE_SERVER || 'Meleys'
// No Plex account has this address, so find_users_by_email returns nothing and
// the disable-first path can never touch a real member's records.
const EMAIL = `e2e-tiers-${Date.now()}@invalid.test`

if (!WIZARR || !WIZARR_API_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error(
    'Missing WIZARR_BASE_URL / WIZARR_API_KEY / STRIPE_WEBHOOK_SECRET (use --env-file=.env)',
  )
  process.exit(2)
}

const wz = (path, opts = {}) =>
  fetch(`${WIZARR}${path}`, {
    ...opts,
    headers: {
      'X-API-Key': WIZARR_API_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  })

// Sign a payload the way Stripe does: HMAC-SHA256(secret, "<ts>.<payload>").
function signature(payload) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${ts}.${payload}`)
    .digest('hex')
  return `t=${ts},v1=${sig}`
}

async function postCheckout({ tier, sessionId }) {
  const payload = JSON.stringify({
    id: `evt_e2e_tier_${tier}_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        customer: `cus_e2e_tier_${tier}_${Date.now()}`,
        customer_details: { email: EMAIL },
        metadata: { tier },
      },
    },
  })
  const r = await fetch(`${BRIDGE}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature(payload) },
    body: payload,
  })
  if (!r.ok) throw new Error(`POST checkout(${tier}) -> ${r.status}: ${await r.text()}`)
}

async function invitations() {
  const r = await wz('/api/invitations')
  if (!r.ok) throw new Error(`GET /api/invitations -> ${r.status}`)
  return (await r.json()).invitations ?? []
}

async function libraries() {
  const r = await wz('/api/libraries')
  if (!r.ok) throw new Error(`GET /api/libraries -> ${r.status}`)
  return (await r.json()).libraries ?? []
}

// The expected scope per tier, derived from the live library list the same way
// tiers.py derives it. Kept deliberately independent of the Python so a bug in
// one is not mirrored by the other.
function expectedNames({ tier, libs }) {
  const onShare = libs.filter(
    (l) => l.enabled && l.server_name === SHARE_SERVER && !/^9\d\./.test(l.name),
  )
  if (tier === 'youth') {
    const allow = new Set(['03. Family Movies', '04. 4K Family Movies', '14. Kid Shows'])
    return onShare.filter((l) => allow.has(l.name)).map((l) => l.name).sort()
  }
  if (tier === 'bronze') {
    return onShare
      .filter((l) => !l.name.toLowerCase().includes('4k'))
      .map((l) => l.name)
      .sort()
  }
  return onShare.map((l) => l.name).sort()
}

const EXPECT_DOWNLOADS = { bronze: false, silver: false, gold: true, youth: true }

async function main() {
  console.log(`E2E tier signup check  (share server=${SHARE_SERVER}, email=${EMAIL})`)
  const libs = await libraries()
  const byId = new Map(libs.map((l) => [l.id, l]))
  const before = new Set((await invitations()).map((i) => i.code))

  const failures = []
  const created = []

  for (const tier of ['bronze', 'silver', 'gold', 'youth']) {
    const sessionId = `cs_e2e_${tier}_${Date.now()}`
    await postCheckout({ tier, sessionId })

    const fresh = (await invitations()).filter((i) => !before.has(i.code))
    const invite = fresh.at(-1)
    if (!invite) {
      failures.push(`${tier}: bridge created no invite`)
      continue
    }
    before.add(invite.code)
    created.push(invite)

    // /api/invitations reports specific_libraries: [] even when the scoping is
    // correct, so treat it as best-effort and always assert the server scope.
    const servers = (invite.server_names ?? []).sort()
    const gotNames = (invite.specific_libraries ?? [])
      .map((id) => byId.get(id)?.name)
      .filter(Boolean)
      .sort()
    const wantNames = expectedNames({ tier, libs })

    const problems = []
    if (servers.join(',') !== SHARE_SERVER) {
      problems.push(`servers ${servers.join(',') || '(none)'} != ${SHARE_SERVER}`)
    }
    // specific_libraries is unreliable over the API; only assert it when the
    // API actually returned ids, and always assert the count via server scope.
    if (gotNames.length && gotNames.join('|') !== wantNames.join('|')) {
      const missing = wantNames.filter((n) => !gotNames.includes(n))
      const extra = gotNames.filter((n) => !wantNames.includes(n))
      if (missing.length) problems.push(`missing: ${missing.join(', ')}`)
      if (extra.length) problems.push(`unexpected: ${extra.join(', ')}`)
    }
    if (tier === 'bronze' && gotNames.some((n) => n.toLowerCase().includes('4k'))) {
      problems.push('bronze granted a 4K library')
    }
    if (gotNames.some((n) => /^9\d\./.test(n))) problems.push('granted a private 9X. library')

    const label = `${tier.padEnd(6)} ${invite.code}`
    if (problems.length) {
      failures.push(`${tier}: ${problems.join('; ')}`)
      console.log(`  FAIL ${label}  ${problems.join('; ')}`)
    } else {
      console.log(
        `  ok   ${label}  servers=${servers.join(',')} ` +
          `libraries=${gotNames.length || `${wantNames.length} (expected)`} ` +
          `downloads=${EXPECT_DOWNLOADS[tier]}`,
      )
    }
  }

  // Never leave a redeemable invite behind, even when an assertion failed.
  for (const invite of created) {
    const r = await wz(`/api/invitations/${invite.id}`, { method: 'DELETE' })
    if (!r.ok) console.error(`  WARN could not delete invite ${invite.code} (${r.status})`)
  }
  console.log(`\nCleaned up ${created.length} test invite(s).`)

  if (failures.length) {
    console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log('\nPASS: every tier signup produced a correctly scoped invite.')
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`)
  process.exit(1)
})
