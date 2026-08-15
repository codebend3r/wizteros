import { create } from 'zustand'
import type { Tier } from '@/site.config'

// The tier tabs live in Pricing while the cost ledger in StatusBoard mirrors
// the selection, so the selected id has to sit between them.
type TierState = {
  selectedTierId: Tier['id']
  selectTier: ({ id }: { id: Tier['id'] }) => void
}

export const useTierStore = create<TierState>((set) => ({
  selectedTierId: 'silver',
  selectTier: ({ id }) => set({ selectedTierId: id }),
}))
