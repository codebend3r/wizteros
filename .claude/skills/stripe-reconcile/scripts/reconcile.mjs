#!/usr/bin/env node
// Read-only audit of the three systems the paid-access flow keeps in sync:
// Stripe (who is paying), the bridge's SQLite store (who the bridge thinks is
// paying), and Wizarr (who actually has access).
//
// The bridge is webhook-driven and fire-and-forget. One missed delivery (a
// Funnel outage, a bridge restart mid-event, a Stripe retry that never landed)
// silently desyncs the three, and nothing else in the repo ever notices. This
// finds that drift and prints it.
//
// STRICTLY READ-ONLY. No Stripe writes, no Wizarr writes, no store writes, no
// container commands on the NAS. The only NAS access is a tar read of the
// bridge's data directory into a temp copy that is deleted before exit.
//
//   stripe   GET /v1/subscriptions?status=all  (customer expanded inline)
//   wizarr   GET /api/users, GET /api/invitations
//   store    bridge.db copied off the NAS, read with `sqlite3 -readonly`
//
// Run: node --env-file-if-exists=.env .claude/skills/stripe-reconcile/scripts/reconcile.mjs
// (--env-file-if-exists, not --env-file: a missing .env makes node itself bail
// with exit 9 before this script can report the misconfiguration as exit 2.)
// Exit: 0 clean, 1 drift found, 2 misconfigured, or Stripe/Wizarr unreadable.
// An unreadable store is NOT exit 2; it degrades to a two-way comparison.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const {
  STRIPE_API_KEY,
  WIZARR_BASE_URL,
  WIZARR_API_KEY,
  ACCESS_DURATION = '35',
  INVITE_EXPIRES_DAYS = '14',
  MAP_DB_PATH = '/data/bridge.db',
} = process.env

const FLAGS = ['--no-store', '--all']
const args = process.argv.slice(2)
const unknown = args.filter((a) => !FLAGS.includes(a))
if (unknown.length) {
  console.error(`unknown flag: ${unknown.join(' ')}  (accepts ${FLAGS.join(', ')})`)
  process.exit(2)
}
const SKIP_STORE = args.includes('--no-store')
const SHOW_ALL = args.includes('--all')

if (!STRIPE_API_KEY || !WIZARR_BASE_URL || !WIZARR_API_KEY) {
  console.error(
    'Missing STRIPE_API_KEY / WIZARR_BASE_URL / WIZARR_API_KEY (use --env-file=.env)',
  )
  process.exit(2)
}

const WIZARR = WIZARR_BASE_URL.replace(/\/+$/, '')
const NAS_HOST = process.env.WZ_NAS_HOST || 'crivas@192.168.50.2'
const NAS_PATH = process.env.WZ_NAS_PATH || '/volume1/docker/stripe-bridge'
// docker-compose.yml binds ./stripe-bridge-data to /data, so MAP_DB_PATH's
// basename is the file inside that directory on the NAS.
const NAS_DATA_DIR = `${NAS_PATH}/stripe-bridge-data`
const SSH_OPTS = '-o BatchMode=yes -o ConnectTimeout=10'

const DAY = 86_400_000
const DURATION = parseInt(ACCESS_DURATION, 10)
const GRACE = parseInt(INVITE_EXPIRES_DAYS, 10)
const NOTE_CAP = 12
const NOW = Date.now()

// A subscription in these states is contributing right now; everything else
// (canceled, unpaid, past_due, incomplete, paused) is not paying today.
const PAYING = new Set(['active', 'trialing'])

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Parse an API timestamp to epoch ms; a naive datetime is read as UTC. */
const parseTime = (value) => {
  if (!value) return null
  const text = /\d{2}:\d{2}/.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? `${value}Z`
    : value
  const ms = new Date(text).getTime()
  return Number.isNaN(ms) ? null : ms
}

const ago = (ms) => `${Math.round(Math.abs(NOW - ms) / DAY)}d`
const date = (ms) => new Date(ms).toISOString().slice(0, 10)

const chunk = ({ items, size }) =>
  items.reduce(
    (acc, item, i) => (i % size === 0 ? [...acc, [item]] : [...acc.slice(0, -1), [...acc.at(-1), item]]),
    [],
  )

/** Run an async mapper over items a batch at a time, in order. */
const mapInBatches = ({ items, size, run }) =>
  chunk({ items, size }).reduce(
    async (acc, batch) => [...(await acc), ...(await Promise.all(batch.map(run)))],
    Promise.resolve([]),
  )

// ─── stripe ───────────────────────────────────────────────────────────────────

const stripeGet = async (path) => {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  })
  const body = await r.json()
  if (!r.ok) {
    const detail = body?.error?.message ?? 'stripe error'
    throw Object.assign(new Error(`GET ${path} -> ${r.status}: ${detail}`), { status: r.status })
  }
  return body
}

/** Walk a Stripe list endpoint to the end via starting_after. */
const stripeList = async ({ path, params, startingAfter = null, acc = [] }) => {
  const qs = new URLSearchParams([...params, ['limit', '100']])
  if (startingAfter) qs.set('starting_after', startingAfter)
  const body = await stripeGet(`${path}?${qs}`)
  const data = [...acc, ...(body.data ?? [])]
  return body.has_more && body.data?.length
    ? stripeList({ path, params, startingAfter: body.data.at(-1).id, acc: data })
    : data
}

/** Does this customer id still resolve? "deleted" and "missing" both count as gone. */
const customerState = async (id) => {
  try {
    const c = await stripeGet(`/customers/${id}`)
    return c.deleted ? 'deleted' : 'live'
  } catch (e) {
    if (e.status === 404) return 'missing'
    throw e
  }
}

/**
 * Every subscription grouped by the customer's lowercased email.
 *
 * The customer is expanded inline so a sweep costs one request per 100 subs
 * rather than one per subscriber. current_period_end moved onto the items in
 * later API versions, so read both places rather than pinning a version.
 */
const stripeByEmail = (subs) =>
  subs.reduce((acc, sub) => {
    const customer = typeof sub.customer === 'object' ? sub.customer : { id: sub.customer }
    const email = (customer.email ?? '').trim().toLowerCase()
    const key = email || customer.id
    const entry = acc.get(key) ?? { email, customerIds: [], paying: [], lapsed: [] }
    const record = {
      id: sub.id,
      status: sub.status,
      customerId: customer.id,
      periodEnd: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null,
      endedAt: sub.ended_at ?? sub.canceled_at ?? null,
    }
    acc.set(key, {
      ...entry,
      email,
      customerIds: entry.customerIds.includes(customer.id)
        ? entry.customerIds
        : [...entry.customerIds, customer.id],
      paying: PAYING.has(sub.status) ? [...entry.paying, record] : entry.paying,
      lapsed: PAYING.has(sub.status) ? entry.lapsed : [...entry.lapsed, record],
    })
    return acc
  }, new Map())

// ─── wizarr ───────────────────────────────────────────────────────────────────

const wz = (path) =>
  fetch(`${WIZARR}${path}`, {
    headers: { 'X-API-Key': WIZARR_API_KEY, 'Content-Type': 'application/json' },
    // /api/users reconciles with every Plex server per call and routinely takes
    // ~15s (see WizarrClient._users and admin.members_snapshot). The bridge caps
    // it at 45s on the request path; double that here, because this sweep is an
    // unattended read and a slow answer beats a spurious "source failed".
    signal: AbortSignal.timeout(90_000),
  })

// The bridge only ever reads id/email/username/server/expires off a user, so
// the enabled flag is probed rather than assumed: whichever boolean the
// deployed Wizarr exposes wins, and none present leaves it unknown (null) with
// expiry as the only access signal.
const ENABLED_KEYS = ['is_enabled', 'enabled', 'accessible', 'active']
const DISABLED_KEYS = ['is_disabled', 'disabled']

const enabledFlag = (u) => {
  const on = ENABLED_KEYS.find((k) => typeof u[k] === 'boolean')
  if (on) return u[on]
  const off = DISABLED_KEYS.find((k) => typeof u[k] === 'boolean')
  if (off) return !u[off]
  return null
}

const mergeEnabled = ({ current, next }) => {
  if (current === null) return next
  if (next === null) return current
  return current || next
}

/**
 * Latest expiry across a person's records, where null (unlimited) wins.
 *
 * One unlimited record still grants access, which is the question here.
 * /admin/members instead keeps the latest non-null value, a display choice:
 * it is showing a date, not deciding whether the member can watch.
 */
const laterExpiry = ({ current, next, first }) => {
  if (first) return next
  if (current === null || next === null) return null
  return next > current ? next : current
}

/**
 * Collapse Wizarr's per-server records into one entry per person, keyed by
 * lowercased email (falling back to username), the way /admin/members does.
 */
const peopleFrom = (users) =>
  users.reduce((acc, u) => {
    const email = (u.email ?? '').trim().toLowerCase()
    const username = u.username ?? ''
    const key = email || username.toLowerCase()
    if (!key) return acc
    const person = acc.get(key) ?? {
      key, email, member: username, servers: [], expires: null, seen: false, enabled: null,
    }
    const server = u.server ?? ''
    acc.set(key, {
      ...person,
      email: person.email || email,
      member: person.member || username,
      servers: server && !person.servers.includes(server) ? [...person.servers, server] : person.servers,
      expires: laterExpiry({ current: person.expires, next: parseTime(u.expires), first: !person.seen }),
      seen: true,
      enabled: mergeEnabled({ current: person.enabled, next: enabledFlag(u) }),
    })
    return acc
  }, new Map())

/** True when the person can still watch: not disabled, and not past their expiry. */
const hasAccess = (person) =>
  person.enabled !== false && (person.expires === null || person.expires > NOW)

// ─── store ────────────────────────────────────────────────────────────────────

const sqlite = ({ db, sql }) => {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' })
  return out.trim() ? JSON.parse(out) : []
}

/**
 * Copy the bridge's SQLite file off the NAS and read customer_map + member_tags.
 *
 * Tars the whole data directory in one shot so a WAL/SHM sidecar comes along
 * with the main file, and selects only the columns PRAGMA reports as present.
 * tier, invited_at and subscribed were all added by migrations, so an older
 * prod DB legitimately lacks them.
 */
const readStore = () => {
  try {
    execFileSync('sh', ['-c', 'command -v sqlite3'], { stdio: 'ignore' })
  } catch {
    return { ok: false, why: 'no sqlite3 CLI on this machine (brew install sqlite)' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'wz-reconcile-'))
  try {
    // pipefail is load-bearing, not decoration: `tar -xf -` reads empty stdin as
    // an empty archive and exits 0 (bsdtar on macOS), so without it a total ssh
    // failure yields a zero-status pipeline and the run misreports "bridge.db not
    // in <dir>", blaming the NAS for a file that is sitting right there.
    execFileSync(
      'sh',
      [
        '-c',
        `set -o pipefail; ssh ${SSH_OPTS} ${NAS_HOST} 'cd ${NAS_DATA_DIR} && tar -cf - .' | tar -xf - -C ${dir}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const db = join(dir, basename(MAP_DB_PATH))
    if (!existsSync(db)) return { ok: false, why: `${basename(MAP_DB_PATH)} not in ${NAS_DATA_DIR}` }

    const columns = sqlite({ db, sql: 'PRAGMA table_info(customer_map)' }).map((c) => c.name)
    const wanted = ['stripe_customer_id', 'email', 'invite_code', 'tier', 'invited_at', 'subscribed']
    const present = wanted.filter((c) => columns.includes(c))
    if (!present.includes('email')) return { ok: false, why: 'customer_map has no email column' }

    const rows = sqlite({
      db,
      sql: `SELECT ${present.join(', ')} FROM customer_map WHERE email IS NOT NULL`,
    })
    const tags = sqlite({ db, sql: 'SELECT email, tag FROM member_tags' })
    return {
      ok: true,
      missingColumns: wanted.filter((c) => !present.includes(c)),
      // Admin-issued placeholder rows are keyed "admin:<email>" and hold no
      // Stripe side; only a real cus_ id can be checked against Stripe.
      rows: new Map(
        rows.map((r) => [
          (r.email ?? '').toLowerCase(),
          {
            email: r.email,
            customerId: (r.stripe_customer_id ?? '').startsWith('cus_') ? r.stripe_customer_id : null,
            inviteCode: r.invite_code ?? null,
            tier: r.tier ?? null,
            invitedAt: parseTime(r.invited_at),
            subscribed: 'subscribed' in r ? !!r.subscribed : null,
          },
        ]),
      ),
      tags: new Map(tags.map((t) => [(t.email ?? '').toLowerCase(), t.tag])),
    }
  } catch (e) {
    // This NAS greets every session with a multi-line post-quantum warning on
    // stderr; keep the last line that is not part of it, so the reported reason
    // is the actual failure and not "See https://openssh.com/pq.html".
    const detail = (e.stderr?.toString() ?? e.message ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('**'))
      .at(-1) ?? 'no error output'
    return { ok: false, why: `could not copy ${NAS_DATA_DIR} from ${NAS_HOST} (${detail})` }
  } finally {
    // Never leave a copy of live member data lying around in /tmp.
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── report ───────────────────────────────────────────────────────────────────

const KINDS = ['PAYING-NO-ACCESS', 'ACCESS-NO-PAYING', 'GHOST-CUSTOMER', 'STORE-FLAG']
const LABELS = {
  'PAYING-NO-ACCESS': 'paying, no working access',
  'ACCESS-NO-PAYING': 'access, not paying',
  'GHOST-CUSTOMER': 'ghost stripe customers',
  'STORE-FLAG': 'store flag mismatches',
}

const line = ({ kind, who, detail }) => `  ${kind.padEnd(18)}${who.padEnd(34)}${detail}`

async function main() {
  console.log(
    `stripe-reconcile (read-only)  (wizarr ${WIZARR}, access window ${DURATION}d, invite grace ${GRACE}d)\n`,
  )

  const [subs, users, invitations] = await Promise.all([
    stripeList({ path: '/subscriptions', params: [['status', 'all'], ['expand[]', 'data.customer']] }),
    wz('/api/users').then(async (r) => {
      if (!r.ok) throw new Error(`GET /api/users -> ${r.status}`)
      return (await r.json()).users ?? []
    }),
    // Best effort: the invite map only rescues members whose Plex email
    // differs from their Stripe email, exactly like the bridge's fallback.
    wz('/api/invitations')
      .then(async (r) => (r.ok ? ((await r.json()).invitations ?? []) : []))
      .catch(() => []),
  ])

  const stripers = stripeByEmail(subs)
  const people = peopleFrom(users)
  const store = SKIP_STORE ? { ok: false, why: 'skipped (--no-store)' } : readStore()

  const payingCount = [...stripers.values()].filter((s) => s.paying.length).length
  console.log('sources')
  console.log(
    `  · stripe   ${String(subs.length).padStart(4)} subscription(s), ${payingCount} customer(s) paying now`,
  )
  console.log(
    `  · wizarr   ${String(users.length).padStart(4)} user record(s) -> ${people.size} member(s)`,
  )
  if (store.ok) {
    console.log(`  · store    ${String(store.rows.size).padStart(4)} customer_map row(s) from ${NAS_HOST}`)
    if (store.missingColumns.length) {
      console.log(`             (older schema: no ${store.missingColumns.join(', ')})`)
    }
  } else {
    console.log(`  · store    UNAVAILABLE: ${store.why}`)
    console.log('             degraded to a two-way Stripe vs Wizarr comparison:')
    console.log('             VIP tags, ghost customers and store flags are NOT checked, and')
    console.log('             invite codes live only in the store, so a member whose Plex email')
    console.log('             differs from their Stripe email IS reported twice. Expect noise.')
  }
  // A cancel disables the Wizarr record but leaves its expiry alone, so with no
  // enabled flag in the payload a disabled member still reads as having access.
  if (!users.some((u) => enabledFlag(u) !== null)) {
    console.log('  · caveat   this Wizarr exposes no enabled/disabled flag on /api/users, so expiry')
    console.log('             is the only access signal. Confirm an "access, not paying" line in')
    console.log('             the admin UI before acting on it.')
  }

  // Stripe email -> Plex username, for members whose Plex account uses another
  // address. Mirrors WizarrClient.find_user_ids_by_invite. Wizarr serializes
  // used_by as a Python repr like "<User 281>", not a username, so the repr id
  // resolves through the user list first; only the exact repr shape is read as
  // an id (a username that merely contains digits stays a username).
  const usernameById = new Map(users.map((u) => [u.id, u.username]))
  const usedByUsername = (raw) => {
    const repr = /^\s*<User (\d+)>\s*$/.exec(raw ?? '')
    return repr ? (usernameById.get(Number(repr[1])) ?? null) : raw
  }
  const usedBy = new Map(
    invitations
      .filter((i) => i.used_by)
      .flatMap((i) => {
        const username = usedByUsername(i.used_by)
        return username ? [[i.code, username]] : []
      }),
  )
  const byUsername = new Map([...people.values()].map((p) => [p.member.toLowerCase(), p]))
  const storeRows = store.ok ? store.rows : new Map()
  const tags = store.ok ? store.tags : new Map()

  const personFor = (email) => {
    const direct = people.get(email)
    if (direct) return direct
    const code = storeRows.get(email)?.inviteCode
    const username = code ? usedBy.get(code) : null
    return username ? (byUsername.get(username.toLowerCase()) ?? null) : null
  }

  // The same hop in reverse, so a member whose Plex account uses another
  // address is not reported twice: once as a payer with no access, once as a
  // freeloader with no payment.
  const codeByUsername = new Map(
    invitations
      .filter((i) => i.used_by)
      .flatMap((i) => {
        const username = usedByUsername(i.used_by)
        return username ? [[username.toLowerCase(), i.code]] : []
      }),
  )
  const emailByCode = new Map(
    [...storeRows.values()].filter((r) => r.inviteCode).map((r) => [r.inviteCode, (r.email ?? '').toLowerCase()]),
  )
  const billingEmail = (person) => {
    const direct = person.email || person.key
    if (stripers.has(direct)) return direct
    const code = codeByUsername.get(person.member.toLowerCase())
    return (code ? emailByCode.get(code) : null) ?? direct
  }

  const findings = []
  const notes = []

  // (a) Paying in Stripe, but Wizarr access is missing, disabled or expired.
  stripers.forEach((sub, key) => {
    if (!sub.paying.length) return
    const email = sub.email || key
    const person = personFor(email)
    const row = storeRows.get(email)
    if (!person) {
      const invited = row?.invitedAt ?? null
      if (invited !== null && NOW - invited <= GRACE * DAY) {
        notes.push(`  pending  ${email.padEnd(34)}invite issued ${ago(invited)} ago, inside the ${GRACE}d grace window`)
        return
      }
      findings.push({
        kind: 'PAYING-NO-ACCESS',
        who: email,
        detail: invited === null
          ? 'active sub, no Wizarr record and no invite on file'
          : `active sub, no Wizarr record, invite issued ${ago(invited)} ago and never redeemed`,
      })
      return
    }
    if (person.enabled === false) {
      findings.push({
        kind: 'PAYING-NO-ACCESS',
        who: email,
        detail: `active sub, Wizarr record disabled (${person.servers.join(', ') || 'no servers'})`,
      })
      return
    }
    if (person.expires !== null && person.expires <= NOW) {
      findings.push({
        kind: 'PAYING-NO-ACCESS',
        who: email,
        detail: `active sub, Wizarr access expired ${ago(person.expires)} ago (${person.servers.join(', ') || 'no servers'})`,
      })
    }
  })

  // (b) Still enabled in Wizarr with nothing paying for it.
  people.forEach((person) => {
    if (!hasAccess(person)) return
    const email = billingEmail(person)
    const sub = stripers.get(email)
    if (sub?.paying.length) return
    if (tags.get(email) === 'vip') {
      notes.push(`  vip      ${email.padEnd(34)}enabled with no Stripe subscription (VIP tag, deliberate)`)
      return
    }
    // When did their money stop covering them? A canceled sub reports ended_at;
    // a past_due or unpaid one never does but is still inside the period it last
    // billed for, so current_period_end is the honest edge there. Without that
    // fallback a member three days into dunning reads as an outright freeloader.
    const paidThrough = sub?.lapsed.reduce(
      (acc, s) => Math.max(acc, (s.endedAt ?? s.periodEnd ?? 0) * 1000),
      0,
    ) ?? 0
    const expiry = person.expires === null ? 'no expiry set' : `expires ${date(person.expires)}`
    if (!sub) {
      const row = storeRows.get(email)
      if (row?.subscribed) {
        findings.push({
          kind: 'STORE-FLAG',
          who: email,
          detail: `store says subscribed, Stripe has no subscription at all (${expiry})`,
        })
        return
      }
      notes.push(`  legacy   ${email.padEnd(34)}enabled, no Stripe customer at all (manual or legacy share)`)
      return
    }
    if (paidThrough && NOW - paidThrough <= DURATION * DAY) {
      notes.push(`  winding  ${email.padEnd(34)}stopped paying, still inside the ${DURATION}d window (paid through ${date(paidThrough)})`)
      return
    }
    findings.push({
      kind: 'ACCESS-NO-PAYING',
      who: email,
      detail: paidThrough
        ? `paid through ${date(paidThrough)}, past the ${DURATION}d window, still enabled, ${expiry}`
        : `no paying subscription (${sub.lapsed.map((s) => s.status).join(', ') || 'none'}), still enabled, ${expiry}`,
    })
  })

  // (c) + (d) Store rows whose Stripe side is gone, and flags that disagree.
  // One line per person: when someone already has a finding above, the store
  // mismatch is folded into it as the diagnosis rather than repeated.
  const folded = new Map()
  if (store.ok) {
    const seen = new Set([...stripers.values()].flatMap((s) => s.customerIds))
    const orphans = [...storeRows.values()].filter((r) => r.customerId && !seen.has(r.customerId))
    const states = await mapInBatches({
      items: orphans,
      size: 5,
      run: async (row) => ({ row, state: await customerState(row.customerId) }),
    })
    states.forEach(({ row, state }) => {
      const email = (row.email ?? '').toLowerCase()
      if (state !== 'live') {
        findings.push({
          kind: 'GHOST-CUSTOMER',
          who: email,
          detail: `store row points at ${row.customerId}, ${state} in Stripe`,
        })
        return
      }
      if (row.subscribed) {
        findings.push({
          kind: 'STORE-FLAG',
          who: email,
          detail: `store says subscribed, ${row.customerId} has no subscription in Stripe`,
        })
      }
    })

    // Recomputed here rather than before the ghost sweep, so a person who picked
    // up a GHOST-CUSTOMER or STORE-FLAG line just above still gets folded into
    // one line instead of appearing twice.
    const already = new Set(findings.map((f) => f.who))

    // The classic missed webhook: Stripe took the money, the bridge never heard.
    stripers.forEach((sub, key) => {
      if (!sub.paying.length) return
      const email = sub.email || key
      const row = storeRows.get(email)
      if (row && row.subscribed !== false) return
      const detail = row
        ? 'the store never recorded the payment (subscribed flag still 0)'
        : 'the store has no customer_map row for them at all'
      if (already.has(email)) {
        folded.set(email, detail)
        return
      }
      findings.push({ kind: 'STORE-FLAG', who: email, detail: `Stripe subscription is active, ${detail}` })
    })
  }

  const ordered = [...findings]
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.who.localeCompare(b.who))
    .map((f) => (folded.has(f.who) ? { ...f, detail: `${f.detail}; ${folded.get(f.who)}` } : f))

  console.log('\ndrift')
  if (ordered.length) {
    console.log(ordered.map(line).join('\n'))
  } else {
    console.log('  none')
  }

  if (notes.length) {
    // Sort before capping, so the default view is a stable alphabetical prefix of
    // what --all prints rather than 12 arbitrary lines in discovery order.
    const sorted = [...notes].sort()
    const shown = SHOW_ALL ? sorted : sorted.slice(0, NOTE_CAP)
    console.log('\nnotes (expected, not drift)')
    console.log(shown.join('\n'))
    if (notes.length > shown.length) {
      console.log(`  … and ${notes.length - shown.length} more (--all to list them)`)
    }
  }

  const counts = KINDS.map((kind) => [kind, ordered.filter((f) => f.kind === kind).length])
  console.log('\nsummary')
  console.log(counts.map(([kind, n]) => `  ${LABELS[kind].padEnd(28)}${n}`).join('\n'))
  console.log(`  ${'notes'.padEnd(28)}${notes.length}`)
  console.log(`  ${'-'.repeat(34)}`)
  console.log(`  ${'drift findings'.padEnd(28)}${ordered.length}`)
  if (!store.ok) console.log('\n  (partial: the bridge store was unreadable, see sources above)')

  if (ordered.length) {
    console.log('\nNothing was changed. Remedy drift by hand from the admin UI, see SKILL.md.')
    process.exit(1)
  }
  console.log(`\nCLEAN: ${payingCount} paying customer(s) all hold live Wizarr access.`)
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`)
  process.exit(2)
})
