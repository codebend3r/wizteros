import { useRef, type KeyboardEvent } from 'react'
import type { Tier } from '@/site.config'
import { useTierStore } from '@/stores/tierStore'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
}

const CHECK_PATH = 'M3.5 8.5 6.5 11.5 12.5 4.5'
const CROSS_PATH = 'M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5'

const INTRO = {
  eyebrow: 'Pick your tier',
  title: 'Four levels of server capability',
  copy:
    "One card at a time, so there's nothing to compare in four directions. " +
    'Playback capability is the only thing that changes between tiers.',
  bullets: [
    'Your invite arrives by email within minutes',
    'Cancel from the billing portal, access ends at cycle end',
    'Youth scopes profiles for family households',
  ],
} as const

const priceOf = (tier: Tier): number => Number(tier.price.replace(/[^0-9.]/g, ''))

// The cheapest costlier tier that includes the feature, e.g. "in Gold, +$6"
// on Silver's excluded downloads row. Null when no upgrade offers it.
const upgradeHint = ({
  tiers,
  current,
  label,
}: {
  tiers: ReadonlyArray<Tier>
  current: Tier
  label: string
}): string | null => {
  const target = tiers
    .filter(
      (tier) =>
        priceOf(tier) > priceOf(current) &&
        tier.features.some((feature) => feature.label === label && feature.included),
    )
    .sort((a, b) => priceOf(a) - priceOf(b))[0]
  return target ? `in ${target.name}, +$${priceOf(target) - priceOf(current)}` : null
}

export const Pricing = ({ tiers }: PricingProps) => {
  const selectedId = useTierStore((state) => state.selectedTierId)
  const selectTier = useTierStore((state) => state.selectTier)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const selected = tiers.find(({ id }) => id === selectedId) ?? tiers[0]

  if (!selected) {
    return null
  }

  const selectByOffset = (offset: number) => {
    const index = tiers.findIndex(({ id }) => id === selected.id)
    const next = tiers[(index + offset + tiers.length) % tiers.length]
    if (next) {
      selectTier({ id: next.id })
      tabRefs.current.get(next.id)?.focus()
    }
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      selectByOffset(1)
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      selectByOffset(-1)
    }
  }

  return (
    <section id="pricing" className={styles.pricing}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{INTRO.eyebrow}</p>
        <h2 className={styles.title}>{INTRO.title}</h2>
        <p className={styles.subtitle}>{INTRO.copy}</p>
        <ul className={styles.bullets}>
          {INTRO.bullets.map((bullet) => (
            <li key={bullet} className={styles.bullet}>
              <span className={styles.bulletDot} aria-hidden="true" />
              {bullet}
            </li>
          ))}
        </ul>
      </header>
      <div className={styles.switcher}>
        <div className={styles.tabs} role="tablist" aria-label="Tiers">
          {tiers.map(({ id, name }) => (
            <button
              key={id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(id, node)
                } else {
                  tabRefs.current.delete(id)
                }
              }}
              className={`${styles.tab} ${styles[id]} ${id === selected.id ? styles.tabSelected : ''}`}
              type="button"
              role="tab"
              id={`tier-tab-${id}`}
              aria-selected={id === selected.id}
              aria-controls="tier-panel"
              tabIndex={id === selected.id ? 0 : -1}
              onClick={() => selectTier({ id })}
              onKeyDown={onTabKeyDown}
            >
              {name}
            </button>
          ))}
        </div>
        <article
          className={`${styles.card} ${styles[selected.id]}`}
          role="tabpanel"
          id="tier-panel"
          aria-labelledby={`tier-tab-${selected.id}`}
        >
          <div className={styles.cardTop} aria-hidden="true" />
          <div className={styles.cardBody}>
            <header className={styles.cardHeader}>
              <p className={styles.price}>
                {selected.price}
                <span className={styles.cadence}>{selected.cadence}</span>
              </p>
              <p className={styles.summary}>{selected.summary}</p>
            </header>
            <ul className={styles.features}>
              {selected.features.map(({ label, included }) => {
                const hint = included ? null : upgradeHint({ tiers, current: selected, label })
                return (
                  <li
                    key={label}
                    className={`${styles.feature} ${included ? styles.included : styles.excluded}`}
                  >
                    <svg className={styles.mark} viewBox="0 0 16 16" aria-hidden="true">
                      <path d={included ? CHECK_PATH : CROSS_PATH} />
                    </svg>
                    <span className={styles.srOnly}>
                      {included ? 'Included:' : 'Not included:'}
                    </span>
                    <span className={styles.label}>{label}</span>
                    {!!hint && <span className={styles.hint}>{hint}</span>}
                  </li>
                )
              })}
            </ul>
            {!!selected.paymentLinkUrl && (
              <a className={styles.cta} href={selected.paymentLinkUrl}>
                Choose {selected.name}
              </a>
            )}
          </div>
        </article>
      </div>
    </section>
  )
}
