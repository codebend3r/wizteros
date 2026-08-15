import logoImage from '@/assets/logo.jpg'
import { HeroLogo } from '@/components/Hero/HeroLogo'
import styles from '@/components/Hero/Hero.module.scss'

const BADGE_LABEL = 'Servers online right now'
const HEADLINE_LINES = ["It's up.", 'Come on in.'] as const
const CTA_LABEL = 'Choose a plan'

// Uptime and maintenance figures are static placeholders until the bridge
// exposes real ones; they mirror the StatusBoard card, which carries the
// canonical copy of the same numbers.
const TICKER_ITEMS = [
  { label: '4K UHD' },
  { label: 'Lossless audio' },
  { label: 'Offline downloads' },
  { label: 'Request queue' },
  { label: 'Uptime 99.94% / 90d', live: true },
  { label: 'Last maintenance 3 days ago', live: true },
] as const

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
const TickerRow = ({ hidden }: { hidden?: boolean }) => (
  <span className={styles.tickerRow} aria-hidden={!!hidden || undefined}>
    {TICKER_ITEMS.map(({ label, ...item }) => (
      <span key={label} className={styles.tickerGroup}>
        <span className={'live' in item && item.live ? styles.tickerLive : styles.tickerItem}>
          {label}
        </span>
        <span className={styles.tickerDot} aria-hidden="true">
          ◆
        </span>
      </span>
    ))}
  </span>
)

export const Hero = ({ brandName, tagline, memberUrl, fromPrice }: HeroProps) => (
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
          <span className={styles.ctaCaption}>From {fromPrice} CAD / month · Cancel any time</span>
        </div>
      </div>
      <div className={styles.art}>
        <HeroLogo />
      </div>
    </div>
    <div className={styles.ticker}>
      <div className={styles.tickerTrack}>
        <TickerRow />
        <TickerRow hidden />
      </div>
    </div>
  </section>
)
