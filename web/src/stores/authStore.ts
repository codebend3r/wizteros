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
    if (!supabase) {
      return
    }
    await supabase.auth.signOut()
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
