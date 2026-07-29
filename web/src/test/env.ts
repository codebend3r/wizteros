// Keep every VITE_* var dormant in tests even though bun auto-loads .env.
// Mirrors the old vitest `test.env` overrides so auth flows are driven through
// the store instead of a live client. Backs import.meta.env via process.env.
//
// Clearing the whole set (not just Supabase) keeps the suite hermetic for
// anyone who fills in web/.env for local dev: several tests assert the
// unset-by-default behavior, e.g. the member link stays hidden without
// VITE_MEMBER_URL.
const DORMANT_VARS: ReadonlyArray<string> = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_ADMIN_API_BASE',
  'VITE_MEMBER_URL',
  'VITE_BILLING_PORTAL_URL',
  'VITE_PAYMENT_LINK_BRONZE_URL',
  'VITE_PAYMENT_LINK_SILVER_URL',
  'VITE_PAYMENT_LINK_GOLD_URL',
  'VITE_PAYMENT_LINK_YOUTH_URL',
]

Object.assign(process.env, Object.fromEntries(DORMANT_VARS.map((name) => [name, ''])))
