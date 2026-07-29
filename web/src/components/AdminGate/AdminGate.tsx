import type { ReactNode } from 'react'
import { LoginGate } from '@/components/LoginGate/LoginGate'
import { useAuthStore } from '@/stores/authStore'

type AdminAuth = {
  deauthenticate: () => void
}

// Kept as the pages' auth hook so their sign-out affordance and 401 handling
// don't need to know it's now a Supabase session under the hood.
export const useAdminAuth = (): AdminAuth => {
  const signOut = useAuthStore((state) => state.signOut)
  return { deauthenticate: () => void signOut() }
}

type AdminGateProps = {
  title: string
  children: ReactNode
}

export const AdminGate = ({ title, children }: AdminGateProps) => (
  <LoginGate title={title}>{children}</LoginGate>
)
