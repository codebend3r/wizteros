import {
  type AdminAuthConfig,
  parseEmailAllowlist,
  trimTrailingSlashes,
} from '@wizteros/server-common'

/** The port the compose healthcheck and the Funnel's /monitor path both reach. */
export const PORT = 8010

/**
 * The Supabase project and admins behind every gated route, from the
 * monitor's FM_-prefixed variables. Read when the guard asks rather than
 * captured at import; a container's environment is fixed at start, so an
 * edited .env still needs the container recreated.
 */
export const adminAuthConfig = (): AdminAuthConfig => ({
  supabaseUrl: trimTrailingSlashes(process.env.FM_SUPABASE_URL),
  allowedEmails: parseEmailAllowlist(process.env.FM_ADMIN_ALLOWED_EMAILS),
})
