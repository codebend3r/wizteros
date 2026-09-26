import {
  type AdminAuthConfig,
  parseEmailAllowlist,
  trimTrailingSlashes,
} from '@wizteros/server-common'

/** The port the compose healthcheck and the Funnel's /monitor path both reach. */
export const PORT = 8010

/**
 * The Supabase project and admins behind every gated route. The monitor
 * prefixes its variables FM_, and they are read per request so a container
 * that started before its env was complete recovers without a restart.
 */
export const adminAuthConfig = (): AdminAuthConfig => ({
  supabaseUrl: trimTrailingSlashes(process.env.FM_SUPABASE_URL),
  allowedEmails: parseEmailAllowlist(process.env.FM_ADMIN_ALLOWED_EMAILS),
})
