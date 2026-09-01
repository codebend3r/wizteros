#!/usr/bin/env node
// Read-only support dossier for ONE member: everything the wizteros stack knows
// about a single email, on one screen, so a symptom can be matched to a cause.
//
//   Stripe        customers for the email, their subscriptions, latest invoice
//   Wizarr        the per-server user records, plus the invitation tied to them
//   Bridge store  the customer_map row (tier, subscribed, invited_at) + events
//   Bridge logs   container lines mentioning the email, plus standing alarms
//
// STRICTLY READ-ONLY, by design and not just by habit. Every admin verb
// (reissue-invite, reset-expiry, reset-tier, set-tag, set-downloads,
// cancel-subscription) sits behind a Supabase session JWT that no CLI can mint,
// so mutations happen in the admin web UI. Nothing here writes: the SQLite
// handle is opened mode=ro and the SSH calls only read.
//
// Run: node --env-file=<env file> .claude/skills/member-triage/scripts/gather-member.mjs member@example.com
// `.env` is gitignored, so whether one exists is a property of the working copy,
// not of the repo: use it when it is there, otherwise pass whichever file holds
// the three values locally, or export them for the command.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { STRIPE_API_KEY, WIZARR_BASE_URL, WIZARR_API_KEY } = process.env

const EMAIL = (process.argv[2] ?? '').trim()
const WIZARR = (WIZARR_BASE_URL ?? '').replace(/\/+$/, '')
const NAS_HOST = process.env.WZ_NAS_HOST ?? 'crivas@192.168.50.2'
const DOCKER = '/usr/local/bin/docker' // the NOPASSWD sudoers rule matches this literal path
const SERVICE = 'stripe-bridge'
// Parsed to a number before it reaches the remote command line: this is the one
// value a caller can set that ends up inside a shell string.
const LOG_TAIL = String(Number.parseInt(process.env.WZ_LOG_TAIL ?? '2000', 10) || 2000)
const DAY = 86_400_000

if (!EMAIL.includes('@')) {
  console.error(
    'Usage: node --env-file=<env file> .claude/skills/member-triage/scripts/gather-member.mjs <email>',
  )
  process.exit(2)
}
// Config is a precondition, not a degradable section: without these three there
// is no dossier to print, so say so once instead of failing twice downstream.
if (!STRIPE_API_KEY || !WIZARR || !WIZARR_API_KEY) {
  console.error(
    'Missing STRIPE_API_KEY / WIZARR_BASE_URL / WIZARR_API_KEY ' +
      '(pass --env-file=<env file>, or export them)',
  )
  process.exit(2)
}

const NONE = 'none found'
const say = (line = '') => console.log(line)
const bullet = (line) => say(`  ${line}`)
const section = (title) => say(`\n── ${title} ${'─'.repeat(Math.max(3, 64 - title.length))}`)

// "2026-09-05 (in 29d)". The relative half is what makes an expiry, a period
// end, or an invite stamp readable without doing date arithmetic in your head.
const when = (value) => {
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value ?? '')
  if (!ms || Number.isNaN(ms)) {
    return 'none'
  }
  const days = Math.round((ms - Date.now()) / DAY)
  const rel = days === 0 ? 'today' : days > 0 ? `in ${days}d` : `${-days}d ago`
  return `${new Date(ms).toISOString().slice(0, 10)} (${rel})`
}

// An execFile failure puts the entire remote command (base64 payload and all)
// in error.message, so prefer stderr and cap whatever is left.
const brief = (error) => {
  const text = (error.stderr ?? '').trim() || (error.message ?? '').split('\n')[0]
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

const money = (invoice) =>
  `${((invoice.amount_paid ?? invoice.amount_due ?? 0) / 100).toFixed(2)} ` +
  `${(invoice.currency ?? '').toUpperCase()}`

// ─── Stripe ───────────────────────────────────────────────────────────────────

const stripeGet = async (path, params) => {
  const query = new URLSearchParams(params).toString()
  const res = await fetch(`https://api.stripe.com/v1/${path}?${query}`, {
    headers: { Authorization: `Bearer ${STRIPE_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  })
  // Status only. An error body can echo the request back, and the key must
  // never reach stdout or a stack trace.
  if (!res.ok) {
    throw new Error(`Stripe GET /v1/${path} responded ${res.status}`)
  }
  return res.json()
}

// Stripe caps a page at 100 objects, so anything that can plausibly exceed that
// (a long-lived customer's subscription history) has to walk has_more.
const stripeList = async (path, params) => {
  const collect = async (acc, startingAfter) => {
    const page = await stripeGet(path, {
      ...params,
      limit: '100',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    const rows = [...acc, ...(page.data ?? [])]
    return page.has_more && rows.length > acc.length ? collect(rows, rows.at(-1).id) : rows
  }
  return collect([], null)
}

// Stripe moved current_period_end off the subscription and onto its items in
// the 2025 API versions; read both so the dossier works on either account.
const periodEnd = (sub) =>
  sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null

const stripeSection = async () => {
  const customers = await stripeList('customers', { email: EMAIL })
  if (!customers.length) {
    bullet(NONE)
    bullet('no Stripe customer carries this address (typo, or they paid from another one)')
    return
  }
  const rows = await Promise.all(
    customers.map(async (customer) => ({
      customer,
      subs: await stripeList('subscriptions', { customer: customer.id, status: 'all' }),
      // Only the newest matters here, so this one never needs paging.
      invoices: (await stripeGet('invoices', { customer: customer.id, limit: '3' })).data ?? [],
    })),
  )
  rows.forEach(({ customer, subs, invoices }) => {
    bullet(
      `customer ${customer.id}  created ${when(customer.created)}  ` +
        `delinquent=${!!customer.delinquent}`,
    )
    bullet(subs.length ? '  subscriptions:' : `  subscriptions: ${NONE}`)
    subs.forEach((sub) =>
      bullet(
        `    ${sub.id}  status=${sub.status}  period_end=${when(periodEnd(sub))}  ` +
          `cancel_at_period_end=${!!sub.cancel_at_period_end}` +
          `${sub.ended_at ? `  ended=${when(sub.ended_at)}` : ''}`,
      ),
    )
    const latest = invoices[0]
    bullet(
      latest
        ? `  latest invoice ${latest.id}  status=${latest.status}  ` +
            `${when(latest.created)}  ${money(latest)}`
        : `  latest invoice: ${NONE}`,
    )
  })
}

// ─── Wizarr ───────────────────────────────────────────────────────────────────

const wz = async (path) => {
  const res = await fetch(`${WIZARR}${path}`, {
    headers: { 'X-API-Key': WIZARR_API_KEY, 'Content-Type': 'application/json' },
    // /api/users reconciles with every Plex server on each call and routinely
    // takes ~15s (see wizarr.py), so it needs a generous ceiling.
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    throw new Error(`Wizarr GET ${path} responded ${res.status}`)
  }
  return res.json()
}

const wizarrSection = async ({ inviteCode }) => {
  const users = ((await wz(`/api/users?email=${encodeURIComponent(EMAIL)}`)).users ?? []).filter(
    (u) => (u.email ?? '').toLowerCase() === EMAIL.toLowerCase(),
  )
  if (!users.length) {
    bullet(`records: ${NONE}`)
  } else {
    bullet(`records: ${users.length} (one per server)`)
    users.forEach((u) =>
      bullet(
        `    id=${String(u.id).padEnd(4)} server=${String(u.server ?? '?').padEnd(10)} ` +
          `expires=${when(u.expires)}  joined=${when(u.created_at)}  user=${u.username ?? '?'}`,
      ),
    )
  }
  // Wizarr's user schema carries no enabled flag, and for Plex a disable is an
  // account-wide plex.tv unfriend whose record the next user sync prunes, so
  // "record present" is the enabled signal and a vanished record is the disable.
  bullet('    (no enabled flag exists: a Plex disable unfriends, and the next sync drops the row)')

  const invitations = (await wz('/api/invitations')).invitations ?? []
  const usernames = new Set(users.map((u) => u.username).filter(Boolean))
  const userIds = new Set(users.map((u) => u.id))
  // Wizarr serializes used_by as a Python repr like "<User 281>", not a
  // username; only the exact repr shape is read as an id (a username that
  // merely contains digits stays a username). See sales-agent's sources.mjs.
  const redeemedByMember = (raw) => {
    const repr = /^\s*<User (\d+)>\s*$/.exec(raw ?? '')
    return repr ? userIds.has(Number(repr[1])) : usernames.has(raw)
  }
  const mine = invitations.filter(
    (inv) => (!!inviteCode && inv.code === inviteCode) || redeemedByMember(inv.used_by),
  )
  if (!mine.length) {
    bullet(`invitations: ${NONE} (no code recorded for this email, and none redeemed by them)`)
    return
  }
  bullet('invitations:')
  mine.forEach((inv) =>
    bullet(
      `    code=${inv.code}  status=${inv.status}  expires=${when(inv.expires)}  ` +
        `used_by=${inv.used_by ?? 'nobody'}  servers=${(inv.server_names ?? []).join(',') || '?'}  ` +
        `libraries=${(inv.specific_libraries ?? []).length}`,
    ),
  )
}

// ─── The NAS: bridge store and container logs ─────────────────────────────────

// One-shot SSH only. The command is a single argv element, so it never passes
// through a local shell, and a bare local `cd` would hit the Mac's zoxide alias.
const ssh = async (command) => {
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', NAS_HOST, command],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  return stdout
}

// SELECT-only, against a connection opened mode=ro so the process could not
// write even by accident. Shipped base64 so the Python survives ssh re-parsing
// the remote command through the login shell.
const storeProgram = `
import json, os, sqlite3
db = sqlite3.connect("file:" + os.environ.get("MAP_DB_PATH", "/data/bridge.db") + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
email = ${JSON.stringify(EMAIL)}
one = lambda sql: [dict(r) for r in db.execute(sql, (email,))]
print(json.dumps({
    "customers": one("SELECT stripe_customer_id, email, invite_code, tier, invited_at, subscribed"
                     " FROM customer_map WHERE lower(email) = lower(?)"),
    "tags": one("SELECT tag FROM member_tags WHERE email = lower(?)"),
    "downloads": one("SELECT allow FROM member_downloads WHERE email = lower(?)"),
    "events": [dict(r) for r in db.execute(
        "SELECT at, action, detail FROM event_log WHERE email = lower(?) ORDER BY id DESC LIMIT 12",
        (email,))],
}))
`

const readStore = async () => {
  const encoded = Buffer.from(storeProgram, 'utf8').toString('base64')
  const out = await ssh(
    `sudo -n ${DOCKER} exec ${SERVICE} python3 -c ` +
      `"import base64;exec(base64.b64decode('${encoded}'))"`,
  )
  return JSON.parse(out)
}

const storeSection = ({ store, error }) => {
  if (error) {
    bullet(`unavailable: ${error}`)
    return
  }
  if (!store.customers.length) {
    bullet(`customer_map: ${NONE} (the bridge has never recorded this email)`)
  } else {
    store.customers.forEach((c) =>
      bullet(
        `customer_map: ${c.stripe_customer_id}  tier=${c.tier ?? 'none'}  ` +
          `subscribed=${c.subscribed}  invited_at=${when(c.invited_at)}  ` +
          `invite=${c.invite_code ?? 'none'}`,
      ),
    )
  }
  bullet(
    `tag=${store.tags[0]?.tag ?? 'none'}  ` +
      `downloads override=${store.downloads.length ? (store.downloads[0].allow ? 'on' : 'off') : 'none'}`,
  )
  if (!store.events.length) {
    bullet(`events: ${NONE}`)
  } else {
    bullet('events (newest first):')
    store.events.forEach((e) =>
      bullet(`    ${e.at.slice(0, 16).replace('T', ' ')}  ${e.action.padEnd(22)} ${e.detail}`),
    )
  }
}

// Alarms carry no email, so a plain grep for the member misses the reason their
// signup failed. Both passes run over the same window.
const ALARMS = /tier scope check:|no libraries resolved|unknown tier|allowlist mismatch|Traceback \(most recent call last\)/

const logsSection = async () => {
  // Tail on the NAS, filter here: no remote quoting of the address, and the
  // same fetched window feeds both the member pass and the alarm pass.
  const lines = (await ssh(`sudo -n ${DOCKER} logs --tail ${LOG_TAIL} ${SERVICE} 2>&1`)).split('\n')
  const needle = EMAIL.toLowerCase()
  const mine = lines.filter((line) => line.toLowerCase().includes(needle))
  bullet(mine.length ? `mentioning ${EMAIL}:` : `mentioning ${EMAIL}: ${NONE}`)
  mine.slice(-25).forEach((line) => bullet(`    ${line.trim()}`))
  const alarms = lines.filter((line) => ALARMS.test(line))
  bullet(alarms.length ? 'alarms in the same window (these carry no email):' : 'alarms: none')
  alarms.slice(-10).forEach((line) => bullet(`    ${line.trim()}`))
}

// ─── main ─────────────────────────────────────────────────────────────────────

// One dead upstream must not cost the whole dossier: a failed section says why
// and the rest still print.
const run = async (title, fn) => {
  section(title)
  try {
    return await fn()
  } catch (error) {
    bullet(`unavailable: ${brief(error)}`)
    return null
  }
}

const main = async () => {
  say(`Member dossier: ${EMAIL}`)
  say(`  wizarr ${WIZARR}   nas ${NAS_HOST}   ${new Date().toISOString().slice(0, 16)}Z`)

  // Read the store first (it is fast, and its invite code is what lets the
  // Wizarr section find the member's invitation), then print in reading order.
  const nasUp = await ssh('true').then(
    () => true,
    () => false,
  )
  const store = nasUp
    ? await readStore().then(
        (value) => ({ store: value, error: null }),
        (error) => ({ store: null, error: brief(error) }),
      )
    : { store: null, error: `NAS unreachable over SSH at ${NAS_HOST}` }

  await run('Stripe', stripeSection)
  await run('Wizarr', () => wizarrSection({ inviteCode: store.store?.customers[0]?.invite_code }))
  await run('Bridge store (NAS)', () => storeSection(store))
  await run(`Bridge logs (NAS, last ${LOG_TAIL} lines)`, async () => {
    if (!nasUp) {
      bullet(`unavailable: NAS unreachable over SSH at ${NAS_HOST}`)
      return
    }
    await logsSection()
  })

  say('\nRunbook: .claude/skills/member-triage/SKILL.md maps these facts to one remedy.')
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`)
  process.exit(1)
})
