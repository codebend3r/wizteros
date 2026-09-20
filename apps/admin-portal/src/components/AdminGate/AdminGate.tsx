import type { ReactNode } from 'react'
import { LoginGate } from '@/components/LoginGate/LoginGate'

type AdminGateProps = {
  title: string
  children: ReactNode
}

export const AdminGate = ({ title, children }: AdminGateProps) => (
  <LoginGate title={title}>{children}</LoginGate>
)
