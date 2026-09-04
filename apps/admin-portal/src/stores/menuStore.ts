import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The hamburger lives in the Header while the drawer it controls lives in
// SideMenu, so the open flag has to sit between them.
type MenuState = {
  readonly open: boolean
  readonly setOpen: ({ open }: { open: boolean }) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Collapsed by default, and persisted so a reload keeps whichever state the
    admin left it in. Anything but a boolean coming back from storage falls
    back to collapsed rather than rendering a drawer from a hand-edited value. */
export const useMenuStore = create<MenuState>()(
  persist(
    (set) => ({
      open: false,
      setOpen: ({ open }) => set({ open }),
    }),
    {
      name: 'wz-menu',
      merge: (persisted, current) => {
        const stored = isRecord(persisted) ? persisted : {}
        return { ...current, open: typeof stored.open === 'boolean' ? stored.open : current.open }
      },
    },
  ),
)
