import { create } from 'zustand'

// The hamburger lives in the Header while the drawer it controls lives in
// SideMenu, so the open flag has to sit between them.
type MenuState = {
  open: boolean
  setOpen: ({ open }: { open: boolean }) => void
}

export const useMenuStore = create<MenuState>((set) => ({
  open: false,
  setOpen: ({ open }) => set({ open }),
}))
