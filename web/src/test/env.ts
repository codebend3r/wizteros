// Keep the Supabase client dormant in tests even though bun auto-loads .env.
// Mirrors the old vitest `test.env` overrides so auth flows are driven through
// the store instead of a live client. Backs import.meta.env via process.env.
process.env.VITE_SUPABASE_URL = ''
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = ''
