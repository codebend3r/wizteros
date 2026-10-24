import { z } from 'zod'
import type { Wire } from './guard.js'

/** Billing is independent of revocation: a successful ban may still need operator action. */
export const banBillingStatusSchema = z.enum([
  'scheduled',
  'already_scheduled',
  'absent',
  'failed',
  'partial',
])

export const banResultSchema = z.object({
  email: z.string(),
  disabled: z.number(),
  canceled: z.number(),
  cancel_at: z.string().nullable(),
  billing_status: banBillingStatusSchema,
})
export type BanResult = Wire<typeof banResultSchema>
