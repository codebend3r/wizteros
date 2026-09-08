import { useState, type AnimationEvent } from 'react'
import logoImage from '@/assets/logo.jpg'
import { HeroLogo } from '@/components/Hero/HeroLogo'
import styles from '@/components/Hero/Hero.module.scss'
import { shuffle } from '@/lib/shuffle'

const BADGE_LABEL = 'Plex, member funded'
const HEADLINE_LINES = ["Everything you'd stream.", "Nothing you'd skip."] as const
const CTA_LABEL = 'Choose a plan'

// Uptime and maintenance figures are static placeholders until the bridge
// exposes real ones; they mirror the StatusBoard card, which carries the
// canonical copy of the same numbers.
const TICKER_ITEMS = [
  '4K UHD',
  '4K and 1080p movies',
  '4K and 1080p TV shows',
  'Sitcoms',
  'Lossless music albums',
  'Anime shows',
  'Anime movies',
  'Documentaries',
  'Kids TV shows',
  'Old TV classics',
  'Offline downloads',
  'Request queue',
  'Uptime 99.94% / 90d',
  'Last maintenance 3 days ago',
] as const

const TONES = ['toneGold', 'toneGreen', 'toneRose'] as const

type Tone = (typeof TONES)[number]

type TickerEntry = { label: string; tone: Tone }

type TickerRows = { lead: ReadonlyArray<TickerEntry>; trail: ReadonlyArray<TickerEntry> }

/**
 * Deals one ticker row: the items in a fresh random order, each painted in a
 * random one of the three tones.
 */
const dealRow = ({ random }: { random: () => number }): ReadonlyArray<TickerEntry> =>
  shuffle({ items: TICKER_ITEMS, random }).map((label) => ({
    label,
    tone: TONES[Math.floor(random() * TONES.length)] ?? 'toneGold',
  }))

/**
 * Advances the loop by one pass. The drift wraps from the end of the trailing
 * row to the start of the leading one, so the lead inherits the trail's deal
 * (keeping the wrap seamless) and only the trail is dealt again.
 */
const advanceRows = ({ trail }: TickerRows): TickerRows => ({
  lead: trail,
  trail: dealRow({ random: Math.random }),
})

const NAV_LINKS = [
  { label: 'Status', href: '#status' },
  { label: 'Tiers', href: '#pricing' },
  { label: 'Where it goes', href: '#where-it-goes' },
] as const

type HeroProps = {
  brandName: string
  tagline: string
  memberUrl: string | null
  fromPrice: string
}

// One drift lap needs the row twice; the copy is decoration, so hide it
// from the accessibility tree.
const TickerRow = ({
  entries,
  hidden,
}: {
  entries: ReadonlyArray<TickerEntry>
  hidden?: boolean
}) => (
  <span className={styles.tickerRow} aria-hidden={!!hidden || undefined}>
    {entries.map(({ label, tone }) => (
      <span key={label} className={styles.tickerGroup}>
        <span className={`${styles.tickerItem} ${styles[tone]}`}>{label}</span>
        <span className={styles.tickerDot} aria-hidden="true">
          ◆
        </span>
      </span>
    ))}
  </span>
)

export const Hero = ({ brandName, tagline, memberUrl, fromPrice }: HeroProps) => {
  const [rows, setRows] = useState<TickerRows>(() => ({
    lead: dealRow({ random: Math.random }),
    trail: dealRow({ random: Math.random }),
  }))
  const onTickerPass = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setRows(advanceRows)
  }

  return (
    <section className={styles.marquee} aria-label="Welcome">
      <header className={styles.nav}>
        <span className={styles.brandGroup}>
          <img className={styles.brandLogo} src={logoImage} alt="" />
          <span className={styles.brand}>{brandName}</span>
        </span>
        <nav className={styles.navLinks} aria-label="Sections">
          {NAV_LINKS.map(({ label, href }) => (
            <a key={href} className={styles.navLink} href={href}>
              {label}
            </a>
          ))}
          {!!memberUrl && (
            <a className={styles.signIn} href={memberUrl}>
              Sign in
            </a>
          )}
        </nav>
      </header>
      <div className={styles.stage}>
        <div className={styles.copy}>
          <p className={styles.badge}>
            <span className={styles.badgeDot} aria-hidden="true" />
            {BADGE_LABEL}
          </p>
          <h1 className={styles.headline}>
            {HEADLINE_LINES.map((line) => (
              <span key={line} className={styles.headlineLine}>
                {line}
              </span>
            ))}
          </h1>
          <p className={styles.tagline}>{tagline}</p>
          <div className={styles.ctaRow}>
            <a className={styles.cta} href="#pricing">
              {CTA_LABEL}
            </a>
            <span className={styles.ctaCaption}>
              From {fromPrice} CAD / month · Cancel any time
            </span>
          </div>
        </div>
        <div className={styles.art}>
          <HeroLogo />
        </div>
      </div>
      <div className={styles.ticker}>
        <div className={styles.tickerTrack} onAnimationIteration={onTickerPass}>
          <TickerRow entries={rows.lead} />
          <TickerRow entries={rows.trail} hidden />
        </div>
      </div>
    </section>
  )
}
