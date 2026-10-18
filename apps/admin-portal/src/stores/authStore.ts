import { create } from 'zustand'
import { supabase } from '@/lib/supabaseClient'

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out'

type AuthState = {
  enabled: boolean
  status: AuthStatus
  email: string | null
  signIn: (credentials: { email: string; password: string }) => Promise<void>
  signOut: () => Promise<void>
}

export const useAuthStore = create<AuthState>(() => ({
  enabled: !!supabase,
  status: supabase ? 'loading' : 'signed-out',
  email: null,
  signIn: async ({ email, password }) => {
    if (!supabase) {
      return
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      throw new Error(error.message)
    }
  },
  signOut: async () => {
    // Clear local session data even when Supabase has no session left or its
    // sign-out request fails. The auth subscription also covers remote expiry.
    useAuthStore.setState({ status: 'signed-out', email: null })
    if (supabase) {
      await supabase.auth.signOut()
    }
  },
}))

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    useAuthStore.setState({
      status: session ? 'signed-in' : 'signed-out',
      email: session?.user.email ?? null,
    })
  })
}
