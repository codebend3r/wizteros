import { AdminLoginButton } from '@/components/AdminLoginButton/AdminLoginButton'
import { Hero } from '@/components/Hero/Hero'
import { StatusBoard } from '@/components/StatusBoard/StatusBoard'
import { Pricing } from '@/components/Pricing/Pricing'
import { Support } from '@/components/Support/Support'
import { Footer } from '@/components/Footer/Footer'
import { siteConfig, type Tier } from '@/site.config'
import styles from '@/App.module.scss'

// "From $8": the cheapest tier's price anchors the marquee caption.
const fromPrice = (tiers: ReadonlyArray<Tier>): string =>
  tiers.reduce(
    (cheapest, tier) =>
      Number(tier.price.replace(/[^0-9.]/g, '')) < Number(cheapest.replace(/[^0-9.]/g, ''))
        ? tier.price
        : cheapest,
    tiers[0]?.price ?? '$8',
  )

export const App = () => (
  <main className={styles.page}>
    <AdminLoginButton />
    <Hero
      brandName={siteConfig.brandName}
      tagline={siteConfig.tagline}
      memberUrl={siteConfig.memberUrl}
      fromPrice={fromPrice(siteConfig.tiers)}
    />
    <StatusBoard />
    <Pricing tiers={siteConfig.tiers} />
    <Support items={siteConfig.supportItems} />
    <Footer memberUrl={siteConfig.memberUrl} billingPortalUrl={siteConfig.billingPortalUrl} />
  </main>
)
