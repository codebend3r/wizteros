import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url: string = import.meta.env.VITE_SUPABASE_URL ?? ''
const publishableKey: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''

// Dormant until both env vars are set, mirroring the VITE_MEMBER_URL
// convention: a null client means the login gate renders nothing extra.
export const supabase: SupabaseClient | null =
  !!url && !!publishableKey ? createClient(url, publishableKey) : null
