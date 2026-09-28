import {
  type AdminAuthConfig,
  parseEmailAllowlist,
  parseList,
  trimTrailingSlashes,
} from '@wizteros/server-common'

// Every environment variable the bridge reads, in one place, so the webhook
// handlers, the admin routes and the invite pipeline cannot disagree about
// what the deployment is configured as. When the admin routes once read the
// same variables with empty-string defaults while the webhook read them
// strictly, a deploy missing WIZARR_API_KEY refused webhooks and served admin
// routes that 500ed one request at a time.
//
// Each value is read when it is asked for rather than captured at import, so
// a test can change the environment between cases. A container's environment
// is fixed when it starts, so production reads the same value every time.

/** The port the Funnel's /stripe path and the deploy check both reach. */
export const PORT = 8000

/**
 * What the process cannot run without. The server checks these at boot so a
 * misconfigured container dies naming all of what is missing at once, rather
 * than accepting webhooks it cannot act on; that includes the SMTP login the
 * invite mail cannot go out without.
 */
export const REQUIRED_ENV: readonly string[] = [
  'STRIPE_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'WIZARR_BASE_URL',
  'WIZARR_API_KEY',
  'PUBLIC_INVITE_BASE',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
]

// Surrounding whitespace and one sign are fine; anything else is a crash at
// startup, which is what a malformed interval should be.
const INTEGER = /^\s*[+-]?\d+\s*$/

const intEnv = ({ name, fallback }: { name: string; fallback: number }): number => {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  if (!INTEGER.test(raw)) {
    throw new Error(`${name} is not an integer: ${JSON.stringify(raw)}`)
  }
  return Number.parseInt(raw, 10)
}

export const wizarrBaseUrl = (): string => trimTrailingSlashes(process.env.WIZARR_BASE_URL)

export const wizarrApiKey = (): string => process.env.WIZARR_API_KEY ?? ''

/** How long an issued invite link stays redeemable, in days. */
export const inviteDays = (): number => intEnv({ name: 'INVITE_EXPIRES_DAYS', fallback: 14 })

/**
 * How long the access a payment buys lasts once redeemed, in days. Kept as
 * the text the environment holds, because that string is what Wizarr's
 * invite `duration` is sent as.
 */
export const accessDuration = (): string => process.env.ACCESS_DURATION ?? '35'

/** The public origin members' invite links are built on. */
export const publicInviteBase = (): string => trimTrailingSlashes(process.env.PUBLIC_INVITE_BASE)

/** The SQLite file holding the customer map, tags, links and event log. */
export const mapDbPath = (): string => process.env.MAP_DB_PATH ?? '/data/bridge.db'

export const stripeApiKey = (): string => process.env.STRIPE_API_KEY ?? ''

export const stripeWebhookSecret = (): string => process.env.STRIPE_WEBHOOK_SECRET ?? ''

export const reconcileIntervalSeconds = (): number =>
  intEnv({ name: 'RECONCILE_INTERVAL_SECONDS', fallback: 3600 })

export const membersSnapshotIntervalSeconds = (): number =>
  intEnv({ name: 'MEMBERS_SNAPSHOT_INTERVAL_SECONDS', fallback: 300 })

/** Wall-clock hour the baseline invites rotate at, in the container's local time. */
export const baselineRotateHour = (): number =>
  intEnv({ name: 'BASELINE_ROTATE_HOUR', fallback: 3 })

/**
 * How long a baseline link stays redeemable. Longer than the daily rotation on
 * purpose: two generations overlap, so a link shared moments before 03:00 is
 * still good for another day rather than dying underneath whoever received it.
 */
export const baselineExpiresDays = (): number =>
  intEnv({ name: 'BASELINE_EXPIRES_DAYS', fallback: 2 })

/** How far out the one-time Invited backfill sets each member's expiry, in days. */
export const backfillExpiryDays = (): number =>
  intEnv({ name: 'BACKFILL_EXPIRY_DAYS', fallback: 14 })

/** The Plex owner token; empty means plex.tv is not consulted at all. */
export const plexToken = (): string => process.env.PLEX_TOKEN ?? ''

export const plexTvBase = (): string => process.env.PLEX_TV_BASE ?? 'https://plex.tv'

export type SmtpConfig = Readonly<{
  host: string
  port: number
  user: string
  pass: string
  from: string
}>

export const smtpConfig = (): SmtpConfig => {
  const user = process.env.SMTP_USER ?? ''
  return {
    host: process.env.SMTP_HOST ?? '',
    port: intEnv({ name: 'SMTP_PORT', fallback: 587 }),
    user,
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.FROM_ADDR ?? user,
  }
}

/**
 * Where operational alerts go. Falls back to the admin allowlist so a fresh
 * deploy still reaches someone without another variable to remember. An empty
 * ALERT_EMAILS counts as unset.
 */
export const alertAddresses = (): string[] =>
  parseList(process.env.ALERT_EMAILS || process.env.ADMIN_ALLOWED_EMAILS)

/**
 * The Supabase project and admins behind every /admin route. Read when the
 * guard asks rather than captured at import; a container's environment is
 * fixed at start, so an edited .env still needs the container recreated.
 */
export const adminAuthConfig = (): AdminAuthConfig => ({
  supabaseUrl: trimTrailingSlashes(process.env.SUPABASE_URL),
  allowedEmails: parseEmailAllowlist(process.env.ADMIN_ALLOWED_EMAILS),
})

/** The portal origins allowed to call the admin routes from a browser. */
export const adminAllowedOrigins = (): string[] => parseList(process.env.ADMIN_ALLOWED_ORIGINS)
