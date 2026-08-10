#!/usr/bin/env node
// End-to-end retest of the paid-access flow against the LIVE Wizarr instance and
// a locally-running stripe-bridge. Deterministic and repeatable: it resets the
// test member's records to a clean baseline, then drives synthetic (signed)
// Stripe webhooks through the bridge and asserts every server record was
// time-boxed.
//
//   reset all N records -> null/enabled
//   checkout.session.completed  -> bridge sets all N to now + ACCESS_DURATION
//   invoice.paid (renewal)      -> bridge sets all N to now + ACCESS_DURATION
//   assert: every record expires ~ now + ACCESS_DURATION
//
// set_expiry is absolute, not additive, so the two paid events land on the same
// window instead of stacking into 2*ACCESS_DURATION.
//
// Run: bun run test:e2e   (from the workspace root)
import crypto from 'node:crypto'

const {
  WIZARR_BASE_URL,
  WIZARR_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  ACCESS_DURATION = '35',
} = process.env

const EMAIL = process.argv[2] || 'codebenderinc@gmail.com'
const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:8000'
const WIZARR = (WIZARR_BASE_URL || '').replace(/\/+$/, '')
const DURATION = parseInt(ACCESS_DURATION, 10)
const CUSTOMER = `cus_e2e_${Date.now()}` // unique so idempotency never skips a run
const DAY = 86_400_000

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
  })

async function recordsFor(email) {
  const r = await wz(`/api/users?email=${encodeURIComponent(email)}`)
  if (!r.ok) throw new Error(`GET /api/users -> ${r.status}`)
  return (await r.json()).users
}

// Sign a payload the way Stripe does: HMAC-SHA256(secret, "<ts>.<payload>").
function signature(payload) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${ts}.${payload}`)
    .digest('hex')
  return `t=${ts},v1=${sig}`
}

async function postEvent(event) {
  const payload = JSON.stringify(event)
  const r = await fetch(`${BRIDGE}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature(payload) },
    body: payload,
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`POST ${event.type} -> ${r.status}: ${body}`)
  return body
}

async function waitForBridge() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${BRIDGE}/stripe/webhook`, { method: 'GET' })
      if (r.status === 405) return // route exists, POST-only
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new Error(`bridge not reachable at ${BRIDGE} (is it running? bun run bridge:up)`)
}

const fmt = (u) =>
  `  id=${String(u.id).padEnd(4)} ${String(u.server).padEnd(10)} expires=${u.expires}`

async function main() {
  console.log(`E2E retest: ${EMAIL}  (duration=${DURATION}d, customer=${CUSTOMER})`)
  await waitForBridge()

  let recs = await recordsFor(EMAIL)
  if (recs.length === 0) throw new Error(`no Wizarr records for ${EMAIL}`)
  console.log(
    `\nFound ${recs.length} server record(s). Resetting to a clean baseline (enable + expiry=null):`,
  )
  console.log(recs.map(fmt).join('\n'))
  for (const u of recs) {
    await wz(`/api/users/${u.id}/enable`, { method: 'POST' })
    // An empty body sets "unlimited" (the API rejects an explicit null).
    const r = await wz(`/api/users/${u.id}/update-expiry`, { method: 'PUT', body: '{}' })
    if (!r.ok) throw new Error(`reset id=${u.id} -> ${r.status}: ${await r.text()}`)
  }

  console.log(
    '\n-> checkout.session.completed (existing member should be time-boxed on all records)',
  )
  console.log(
    await postEvent({
      id: `evt_e2e_checkout_${Date.now()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_e2e',
          object: 'checkout.session',
          customer: CUSTOMER,
          customer_details: { email: EMAIL },
        },
      },
    }),
  )

  console.log('-> invoice.paid (renewal, billing_reason=subscription_cycle)')
  console.log(
    await postEvent({
      id: `evt_e2e_renewal_${Date.now()}`,
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          object: 'invoice',
          customer: CUSTOMER,
          customer_email: EMAIL,
          billing_reason: 'subscription_cycle',
        },
      },
    }),
  )

  // set-expiry is absolute (not additive): every paid event sets expiry to
  // update-time + DURATION, so after the flow each record is ~ now + DURATION.
  const target = Date.now() + DURATION * DAY
  const toleranceDays = 2
  recs = await recordsFor(EMAIL)
  console.log(
    `\nAfter flow (expected ~ ${new Date(target).toISOString().slice(0, 10)}, i.e. now + ${DURATION}d):`,
  )
  console.log(recs.map(fmt).join('\n'))

  const failures = recs.filter((u) => {
    if (!u.expires) return true
    const diffDays = Math.abs(new Date(u.expires).getTime() - target) / DAY
    return diffDays > toleranceDays
  })

  if (failures.length) {
    console.error(
      `\nFAIL: ${failures.length}/${recs.length} record(s) not set to ~now+${DURATION}d:`,
    )
    console.error(failures.map(fmt).join('\n'))
    process.exit(1)
  }
  console.log(
    `\nPASS: all ${recs.length} server record(s) expire ~now + ${DURATION} days (update date + ${DURATION}).`,
  )
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`)
  process.exit(1)
})
