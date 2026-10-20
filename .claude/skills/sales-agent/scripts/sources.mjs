import {
  bridgeOps,
  shellQuote,
  stripeList as stripeWalk,
  wizarrGet as wizarrRead,
} from '../../_shared/ops.mjs'

const REQUIRED = ['STRIPE_API_KEY', 'WIZARR_BASE_URL', 'WIZARR_API_KEY']
const PAYING = new Set(['active', 'trialing'])
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

const stripeList = ({ config }) =>
  /** Page through every subscription, customer expanded inline. */
  stripeWalk({
    key: config.stripeKey,
    path: 'subscriptions',
    params: [
      ['status', 'all'],
      ['expand[]', 'data.customer'],
    ],
  })

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
    return { ...acc, [email]: { status: winning } }
  }, {})

export const wizarrList = ({ body, key, path }) => {
  /**
   * Unwrap a Wizarr list envelope such as { users: [...], count: N }. A bare array
   * passes through unchanged. A missing or unexpected top-level key degrades to an
   * empty array, so a future Wizarr version that renames or drops the key does not
   * crash the tool. A key that is present but holds something other than a list
   * fails loudly, naming the endpoint and what came back, instead of surfacing
   * later as a bare "reduce is not a function".
   */
  if (Array.isArray(body)) {
    return body
  }
  const value = body?.[key]
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error(`wizarr GET ${path} -> expected ${key} to be an array, got ${typeof value}`)
  }
  return value
}

const wizarrGet = async ({ config, path, key }) =>
  /** One Wizarr GET with the long timeout /api/users needs, unwrapped to a plain list. */
  wizarrList({
    body: await wizarrRead({
      base: config.wizarrBase,
      key: config.wizarrKey,
      path,
      timeoutMs: WIZARR_TIMEOUT_MS,
    }),
    key,
    path,
  })

export const peopleFrom = ({ users }) =>
  /**
   * One entry per person, keyed on lowercased email falling back to username.
   * Unlimited access (a null expiry) always wins over a dated one: this decides
   * whether someone can still watch, and one unlimited record means they can.
   * Each person also collects every Wizarr record id they hold, since one person
   * can carry a different id on every server, and the invite-code fallback in
   * joinMembers needs to reach them by any of those ids.
   */
  Object.values(
    users.reduce((acc, user) => {
      const key = (user.email ?? user.username ?? '').toLowerCase()
      if (!key) {
        return acc
      }
      const current = acc[key]
      const expires =
        current && (current.expires === null || user.expires === null)
          ? null
          : ([current?.expires, user.expires].filter(Boolean).sort().at(-1) ?? null)
      const ids = [
        ...(current?.ids ?? []),
        ...(user.id === undefined || user.id === null ? [] : [user.id]),
      ]
      return {
        ...acc,
        [key]: {
          email: (user.email ?? '').toLowerCase() || null,
          username: user.username ?? current?.username ?? null,
          expires,
          ids,
        },
      }
    }, {}),
  )

// Kept as this module's export too, since its callers and tests import it here.
export { shellQuote }

const readStore = async () => {
  /**
   * Every customer row and tag, through the bridge's read-only ops CLI over
   * SSH: one row per email, picked and read (tier aliases, tag guard) exactly
   * as the bridge reads its own store, without copying bridge.db off the NAS.
   */
  try {
    const { customers, tags } = await bridgeOps({ args: ['customers'] })
    const tagOf = new Map(tags.map(({ email, tag }) => [email, tag]))
    const rows = customers.map((row) => ({
      email: row.email,
      tier: row.tier,
      invited_at: row.invited_at,
      subscribed: row.subscribed,
      invite_code: row.invite_code,
      tag: tagOf.get(row.email) ?? null,
    }))
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, why: error.message, rows: [] }
  }
}

const REPR_ID = /^\s*<User (\d+)>\s*$/

const personForInvite = ({ usedBy, byId, byUsername }) => {
  /**
   * Wizarr's used_by is a Python repr like "<User 277>", not a username, so the
   * match has to go through the numeric id embedded in that repr rather than a
   * username lookup. Which path applies is decided by shape, not by whether
   * digits happen to be present: only a string that matches the repr form
   * end to end (tolerant of surrounding whitespace) is treated as an id
   * reference, and only then is the captured id looked up. Anything else,
   * including a plain username that happens to contain digits such as
   * "amols7", is treated as a username. A loose digit search would misread
   * that username as id 7 and silently fail to match; matching the whole
   * repr shape keeps the two cases unambiguous. An id that parses but
   * matches nobody, or a shape that matches neither form, returns no match
   * rather than guessing at a wrong person, and never throws.
   */
  if (!usedBy) {
    return undefined
  }
  const idMatch = usedBy.match(REPR_ID)
  return idMatch ? byId[idMatch[1]] : byUsername[usedBy.toLowerCase()]
}

const storeRowSortKey = (row) =>
  `${row.invited_at ?? ''} ${row.invite_code ?? ''} ${row.tier ?? ''}`

const mergeStoreRows = ({ rows }) => {
  /**
   * Merge every customer_map row for one email into a single row, following
   * apps/stripe-bridge/src/roster.ts's dedupeMembers merge-by-key
   * pattern so this tool's cohorts agree with what the operator sees on
   * /manage. One email can hold several Stripe customer ids (a known, valid
   * state, not corrupt data), and the ranking below is sorted (by invited_at,
   * then invite_code, then tier) so the merge is deterministic regardless of
   * the order SQLite happens to return the rows in.
   *
   * subscribed is a logical OR across every row: losing a true here would
   * misfile a paying member as declined, the worst error this tool can make.
   * invited_at takes the most recent non-null value, since it starts the
   * grace clock and the newest invite is the one that matters. tier and
   * invite_code both follow the row whose invited_at was kept, since the
   * code and its stamp belong together; tier falls back to any non-null
   * tier from another row only when the winning row itself has none. tag
   * takes any non-null value, so a VIP flagged on a single row survives the
   * merge even when other rows for the same person carry no tag at all.
   */
  const ranked = [...rows].sort((a, b) => {
    const keyA = storeRowSortKey(a)
    const keyB = storeRowSortKey(b)
    return keyA > keyB ? -1 : keyA < keyB ? 1 : 0
  })
  const winner = ranked[0]
  const fallbackTier = ranked.reduce((tier, row) => tier ?? row.tier ?? null, null)
  const tag = ranked.reduce((found, row) => found ?? row.tag ?? null, null)
  return {
    email: winner.email.toLowerCase(),
    tier: winner.tier ?? fallbackTier,
    invited_at: winner.invited_at ?? null,
    invite_code: winner.invite_code ?? null,
    subscribed: rows.some((row) => !!row.subscribed) ? 1 : 0,
    tag,
  }
}

const collapseStoreRows = ({ storeRows }) =>
  /**
   * One row per lowercased email. A single email can carry several
   * customer_map rows, one per Stripe customer id, and without this collapse
   * each extra row becomes its own member, its own cohort entry, and its own
   * outreach send to the same person.
   */
  Object.values(
    storeRows.reduce((acc, row) => {
      const email = row.email.toLowerCase()
      return { ...acc, [email]: [...(acc[email] ?? []), row] }
    }, {}),
  ).map((rows) => mergeStoreRows({ rows }))

export const joinMembers = ({ storeRows, people, stripe, invitations }) => {
  /**
   * One member per person, enriched with the Wizarr expiry and Stripe status.
   * storeRows is collapsed to one row per lowercased email first (see
   * collapseStoreRows), so a person with several Stripe customer ids never
   * produces duplicate members.
   *
   * The direct email match is tried first. When it misses, the invite code is
   * used to reach the person who redeemed it via personForInvite (by Wizarr
   * record id, since used_by is a repr, not a username), which is how a member
   * whose Plex email differs from their Stripe email keeps their real expiry
   * instead of reading as someone who never had access.
   */
  const byEmail = people.reduce(
    (acc, person) => (person.email ? { ...acc, [person.email]: person } : acc),
    {},
  )
  const byUsername = people.reduce(
    (acc, person) => (person.username ? { ...acc, [person.username.toLowerCase()]: person } : acc),
    {},
  )
  const byId = people.reduce(
    (acc, person) => (person.ids ?? []).reduce((inner, id) => ({ ...inner, [id]: person }), acc),
    {},
  )
  const redeemedBy = invitations.reduce(
    (acc, invite) => (invite.code ? { ...acc, [invite.code]: invite.used_by ?? null } : acc),
    {},
  )
  return collapseStoreRows({ storeRows }).map((row) => {
    const email = row.email.toLowerCase()
    const viaCode = row.invite_code
      ? personForInvite({ usedBy: redeemedBy[row.invite_code], byId, byUsername })
      : undefined
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
    wizarrGet({ config, path: '/api/users', key: 'users' }),
    wizarrGet({ config, path: '/api/invitations', key: 'invitations' }),
  ])
  const store = skipStore
    ? { ok: false, why: 'skipped with --no-store', rows: [] }
    : await readStore()
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
