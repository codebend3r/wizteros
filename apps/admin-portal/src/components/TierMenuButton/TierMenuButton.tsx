import { useEffect, useRef, useState } from 'react'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import type { PaidTier } from '@/lib/adminApi'
import { PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import styles from '@/components/TierMenuButton/TierMenuButton.module.scss'

type TierMenuButtonProps = {
  label: string
  busy: boolean
  onSelect: (selection: { tier: PaidTier }) => void
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end'
  /** Told when the menu opens or closes, for a host that has to restack it. */
  onOpenChange?: (state: { open: boolean }) => void
}

const ignoreOpenChange = () => undefined

/**
 * The invite control: one button that opens the paid-tier menu and hands back
 * the tier that was picked.
 *
 * It owns its own open state, so the members table and the member page can no
 * longer drift apart over the same markup, and a click anywhere outside it
 * closes it — including on another instance's button, which is how only one
 * menu is ever open at a time.
 */
export const TierMenuButton = ({
  label,
  busy,
  onSelect,
  align = 'start',
  onOpenChange = ignoreOpenChange,
}: TierMenuButtonProps) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const setMenuOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange({ open: next })
  }

  useEffect(() => {
    if (!open) {
      return
    }
    const close = () => {
      setOpen(false)
      onOpenChange({ open: false })
    }
    // A click inside the control is the button's or an item's own business;
    // anything else dismisses the menu.
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && (wrapRef.current?.contains(target) ?? false)) {
        return
      }
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onOpenChange])

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        className={styles.invite}
        type="button"
        onClick={() => setMenuOpen(!open)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? 'Inviting…' : label}
      </button>
      {open && (
        <ul
          className={`${styles.menu} ${align === 'end' ? styles.menuEnd : ''}`.trim()}
          role="menu"
        >
          {PAID_TIERS.map((tier) => (
            <li key={tier} role="none">
              <button
                className={styles.menuItem}
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onSelect({ tier })
                }}
              >
                <TierIcon tier={tier} /> {TIER_LABELS[tier]} Tier
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
