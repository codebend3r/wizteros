import { useRef, type KeyboardEvent } from 'react'
import type { Tier } from '@/site.config'
import { amountOf, type BillingCadence } from '@/lib/billing'
import { BillingToggle } from '@/components/BillingToggle/BillingToggle'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
  // Off on the live landing page. The hidden /annual route turns it on to get
  // the cadence switch, and to draw the button even when no payment link backs
  // it yet, so the card can be judged whole rather than with its CTA missing.
  preview?: boolean
}

const CHECK_PATH = 'M3.5 8.5 6.5 11.5 12.5 4.5'
const CROSS_PATH = 'M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5'

const INTRO = {
  eyebrow: 'Pick your tier',
  title: 'Four levels of server capability',
  copy:
    "One card at a time, so there's nothing to compare in four directions. " +
    'Playback capability is the only thing that changes between tiers.',
} as const

// Only the cancellation line moves with the cadence, because that is the one
// promise a yearly charge actually changes.
const BULLETS: Record<BillingCadence, ReadonlyArray<string>> = {
  monthly: [
    'Your invite arrives by email within minutes',
    'Cancel from the billing portal, access ends at cycle end',
    'Youth scopes profiles for family households',
  ],
  annual: [
    'Your invite arrives by email within minutes',
    'Cancel from the billing portal, access runs to the end of the paid year',
    'Youth scopes profiles for family households',
  ],
}

const priceOf = (tier: Tier): number => amountOf(tier.price)

// The cheapest costlier tier that includes the feature, e.g. "in Gold, +$6"
// on Silver's excluded downloads row. Null when no upgrade offers it. The
// delta is quoted in the cadence on screen so it never mixes a yearly card
// with a monthly difference.
const upgradeHint = ({
  tiers,
  current,
  label,
  cadence,
}: {
  tiers: ReadonlyArray<Tier>
  current: Tier
  label: string
  cadence: BillingCadence
}): string | null => {
  const target = tiers
    .filter(
      (tier) =>
        priceOf(tier) > priceOf(current) &&
        tier.features.some((feature) => feature.label === label && feature.included),
    )
    .sort((a, b) => priceOf(a) - priceOf(b))[0]
  if (!target) {
    return null
  }
  return cadence === 'annual'
    ? `in ${target.name}, +$${amountOf(target.annual.total) - amountOf(current.annual.total)} a year`
    : `in ${target.name}, +$${priceOf(target) - priceOf(current)}`
}

export const Pricing = ({ tiers, preview = false }: PricingProps) => {
  const selectedId = useTierStore((state) => state.selectedTierId)
  const selectTier = useTierStore((state) => state.selectTier)
  const cadence = useBillingStore((state) => state.cadence)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const selected = tiers.find(({ id }) => id === selectedId) ?? tiers[0]

  if (!selected) {
    return null
  }

  const isAnnual = cadence === 'annual'
  const headlinePrice = isAnnual ? selected.annual.perMonth : selected.price
  const headlineCadence = isAnnual ? selected.annual.cadence : selected.cadence
  const ctaUrl = isAnnual ? selected.annual.paymentLinkUrl : selected.paymentLinkUrl
  const ctaLabel = isAnnual ? `Choose ${selected.name}, billed annually` : `Choose ${selected.name}`

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
          {BULLETS[cadence].map((bullet) => (
            <li key={bullet} className={styles.bullet}>
              <span className={styles.bulletDot} aria-hidden="true" />
              {bullet}
            </li>
          ))}
        </ul>
      </header>
      <div className={styles.switcher}>
        {preview && <BillingToggle />}
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
        {/* Prices change without focus moving, so announce the new figure. */}
        <p className={styles.srOnly} role="status">
          {`${selected.name}, ${headlinePrice} ${headlineCadence}`}
        </p>
        <article
          className={`${styles.card} ${styles[selected.id]}`}
          role="tabpanel"
          id="tier-panel"
          aria-labelledby={`tier-tab-${selected.id}`}
        >
          <div className={styles.cardTop} aria-hidden="true" />
          <div className={styles.cardBody}>
            <header className={styles.cardHeader}>
              <div className={styles.priceBlock}>
                <p className={styles.price}>
                  {headlinePrice}
                  <span className={styles.cadence}>{headlineCadence}</span>
                </p>
                {isAnnual && (
                  <p className={styles.compare}>
                    <span className={styles.was}>
                      <span className={styles.srOnly}>Instead of</span>
                      <s>{`${selected.price} / month`}</s>
                    </span>
                    <span className={styles.savings}>{selected.annual.savings}</span>
                  </p>
                )}
              </div>
              <p className={styles.summary}>{selected.summary}</p>
            </header>
            <ul className={styles.features}>
              {selected.features.map(({ label, included }) => {
                const hint = included
                  ? null
                  : upgradeHint({ tiers, current: selected, label, cadence })
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
            {!!ctaUrl && (
              <a className={styles.cta} href={ctaUrl}>
                {ctaLabel}
              </a>
            )}
            {/* Preview only: the same button, drawn but going nowhere, so an
                unconfigured cadence does not leave a hole in the card. */}
            {!ctaUrl && preview && (
              <button className={styles.cta} type="button" aria-disabled="true">
                {ctaLabel}
              </button>
            )}
            {!ctaUrl && preview && (
              <p className={styles.chargeNote}>No payment link configured, so this does nothing.</p>
            )}
            {isAnnual && (
              <p className={styles.chargeNote}>
                {`One ${selected.annual.total} CAD charge covers the next twelve months.`}
              </p>
            )}
          </div>
        </article>
      </div>
    </section>
  )
}
