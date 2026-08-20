import { create } from 'zustand'
import type { BillingCadence } from '@/lib/billing'

// Monthly is what ships today. The hidden /annual preview is the only surface
// that flips this, and it resets on the way out, so the live landing page can
// never inherit a cadence its checkout links do not back yet.
type BillingState = {
  cadence: BillingCadence
  setCadence: ({ cadence }: { cadence: BillingCadence }) => void
}

export const useBillingStore = create<BillingState>((set) => ({
  cadence: 'monthly',
  setCadence: ({ cadence }) => set({ cadence }),
}))
