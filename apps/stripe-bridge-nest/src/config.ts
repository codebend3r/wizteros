import {
  type AdminAuthConfig,
  parseEmailAllowlist,
  parseList,
  trimTrailingSlashes,
} from '@wizteros/server-common'

/** The port the Funnel's /stripe path and the deploy check both reach. */
export const PORT = 8000

/**
 * The Supabase project and admins behind every /admin route, read per
 * request so a container that started before its env was complete recovers
 * without a restart.
 */
export const adminAuthConfig = (): AdminAuthConfig => ({
  supabaseUrl: trimTrailingSlashes(process.env.SUPABASE_URL),
  allowedEmails: parseEmailAllowlist(process.env.ADMIN_ALLOWED_EMAILS),
})

/** The portal origins allowed to call the admin routes from a browser. */
export const adminAllowedOrigins = (): string[] => parseList(process.env.ADMIN_ALLOWED_ORIGINS)
