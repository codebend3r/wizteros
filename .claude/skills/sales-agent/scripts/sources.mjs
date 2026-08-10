import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REQUIRED = ['STRIPE_API_KEY', 'WIZARR_BASE_URL', 'WIZARR_API_KEY']
const PAYING = new Set(['active', 'trialing'])
const NAS_HOST = process.env.WZ_NAS_HOST || 'crivas@192.168.50.2'
const NAS_PATH = process.env.WZ_NAS_PATH || '/volume1/docker/stripe-bridge'
const SSH_OPTS = '-o BatchMode=yes -o ConnectTimeout=10'
const WIZARR_TIMEOUT_MS = 60_000

export const requireConfig = ({ env = process.env } = {}) => {
  /** Validate the three required variables up front, naming every missing one. */
  const missing = REQUIRED.filter((name) => !env[name])
  if (missing.length) {
    throw new Error(`Missing ${missing.join(' / ')}`)
  }
  return {
    stripeKey: env.STRIPE_API_KEY,
    wizarrBase: env.WIZARR_BASE_URL.replace(/\/+$/, ''),
    wizarrKey: env.WIZARR_API_KEY,
  }
}

const stripeList = async ({ config, startingAfter = null, acc = [] }) => {
  /** Page through every subscription, customer expanded inline. */
  const params = new URLSearchParams({ limit: '100', status: 'all' })
  params.append('expand[]', 'data.customer')
  if (startingAfter) {
    params.set('starting_after', startingAfter)
  }
  const res = await fetch(`https://api.stripe.com/v1/subscriptions?${params}`, {
    headers: { Authorization: `Bearer ${config.stripeKey}` },
  })
  if (!res.ok) {
    throw new Error(`stripe GET /v1/subscriptions -> ${res.status}`)
  }
  const page = await res.json()
  const next = [...acc, ...page.data]
  return page.has_more && page.data.length
    ? stripeList({ config, startingAfter: page.data.at(-1).id, acc: next })
    : next
}

export const stripeByEmail = ({ subs }) =>
  /**
   * Collapse subscriptions to one status per email. A paying status wins, so a
   * customer holding one canceled and one active subscription reads as active.
   */
  subs.reduce((acc, sub) => {
    const email = (sub.customer?.email ?? '').toLowerCase()
    if (!email) {
      return acc
    }
    const current = acc[email]
    const winning = current && PAYING.has(current.status) ? current.status : sub.status
    return { ...acc, [email]: { status: winning, customerId: sub.customer?.id ?? null } }
  }, {})

const wizarrGet = async ({ config, path }) => {
  /** One Wizarr GET with the long timeout /api/users needs. */
  const res = await fetch(`${config.wizarrBase}${path}`, {
    headers: { 'X-API-Key': config.wizarrKey },
    signal: AbortSignal.timeout(WIZARR_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`wizarr GET ${path} -> ${res.status}`)
  }
  return res.json()
}

export const peopleFrom = ({ users }) =>
  /**
   * One entry per person, keyed on lowercased email falling back to username.
   * Unlimited access (a null expiry) always wins over a dated one: this decides
   * whether someone can still watch, and one unlimited record means they can.
   */
  Object.values(
    users.reduce((acc, user) => {
      const key = (user.email ?? user.username ?? '').toLowerCase()
      if (!key) {
        return acc
      }
      const current = acc[key]
      const expires = current && (current.expires === null || user.expires === null)
        ? null
        : [current?.expires, user.expires].filter(Boolean).sort().at(-1) ?? null
      return {
        ...acc,
        [key]: {
          email: (user.email ?? '').toLowerCase() || null,
          username: user.username ?? current?.username ?? null,
          expires,
        },
      }
    }, {}),
  )

const readStore = () => {
  /**
   * Copy bridge.db off the NAS and read it with sqlite3, deleting the temp copy
   * before returning. Columns come from PRAGMA table_info because tier,
   * invited_at, and subscribed were all added by migrations.
   */
  const dir = mkdtempSync(join(tmpdir(), 'wz-sales-'))
  try {
    execFileSync(
      'sh',
      ['-c', `ssh ${SSH_OPTS} ${NAS_HOST} "cat ${NAS_PATH}/stripe-bridge-data/bridge.db" > ${join(dir, 'bridge.db')}`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const db = join(dir, 'bridge.db')
    const columns = JSON.parse(
      execFileSync('sqlite3', ['-readonly', '-json', db, 'PRAGMA table_info(customer_map)'], { encoding: 'utf8' }) || '[]',
    ).map((row) => row.name)
    const pick = (name) => (columns.includes(name) ? name : `NULL AS ${name}`)
    const sql = `SELECT c.email, ${pick('tier')}, ${pick('invited_at')}, ${pick('subscribed')}, c.invite_code, t.tag
                 FROM customer_map c LEFT JOIN member_tags t ON lower(c.email) = t.email
                 WHERE c.email IS NOT NULL`
    const rows = JSON.parse(
      execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }) || '[]',
    )
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, why: error.message, rows: [] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const joinMembers = ({ storeRows, people, stripe, invitations }) => {
  /**
   * One member per store row, enriched with the Wizarr expiry and Stripe status.
   *
   * The direct email match is tried first. When it misses, the invite code is
   * used to reach the Plex username that redeemed it, which is how a member
   * whose Plex email differs from their Stripe email keeps their real expiry
   * instead of reading as someone who never had access.
   */
  const byEmail = people.reduce((acc, person) => (person.email ? { ...acc, [person.email]: person } : acc), {})
  const byUsername = people.reduce(
    (acc, person) => (person.username ? { ...acc, [person.username.toLowerCase()]: person } : acc),
    {},
  )
  const redeemedBy = invitations.reduce(
    (acc, invite) => (invite.code && invite.used_by ? { ...acc, [invite.code]: invite.used_by.toLowerCase() } : acc),
    {},
  )
  return storeRows.map((row) => {
    const email = row.email.toLowerCase()
    const viaCode = row.invite_code ? byUsername[redeemedBy[row.invite_code]] : undefined
    const person = byEmail[email] ?? viaCode
    return {
      email,
      tag: row.tag ?? null,
      tier: row.tier ?? null,
      subscribed: !!row.subscribed,
      invitedAt: row.invited_at ?? null,
      expires: person?.expires ?? null,
      stripeStatus: stripe[email]?.status ?? null,
    }
  })
}

export const fetchAll = async ({ config, skipStore = false }) => {
  /** Read all three upstreams and return joined members plus per-source status. */
  const [subs, users, invitations] = await Promise.all([
    stripeList({ config }),
    wizarrGet({ config, path: '/api/users' }),
    wizarrGet({ config, path: '/api/invitations' }),
  ])
  const store = skipStore ? { ok: false, why: 'skipped with --no-store', rows: [] } : readStore()
  return {
    members: joinMembers({
      storeRows: store.rows,
      people: peopleFrom({ users }),
      stripe: stripeByEmail({ subs }),
      invitations,
    }),
    sources: {
      stripe: `${subs.length} subscriptions`,
      wizarr: `${users.length} records`,
      store: store.ok ? `${store.rows.length} rows` : `unavailable: ${store.why}`,
    },
  }
}
