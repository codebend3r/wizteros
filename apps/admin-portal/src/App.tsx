import { AdminLoginButton } from '@/components/AdminLoginButton/AdminLoginButton'
import { Hero } from '@/components/Hero/Hero'
import { Pricing } from '@/components/Pricing/Pricing'
import { StatusBoard } from '@/components/StatusBoard/StatusBoard'
import { Support } from '@/components/Support/Support'
import { Footer } from '@/components/Footer/Footer'
import { fromPrice } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import { siteConfig } from '@/site.config'
import styles from '@/App.module.scss'

export const App = () => {
  const cadence = useBillingStore((state) => state.cadence)

  return (
    <main className={styles.page}>
      <AdminLoginButton />
      <Hero
        brandName={siteConfig.brandName}
        tagline={siteConfig.tagline}
        memberUrl={siteConfig.memberUrl}
        fromPrice={fromPrice({ tiers: siteConfig.tiers, cadence })}
      />
      <Pricing tiers={siteConfig.tiers} />
      <StatusBoard tiers={siteConfig.tiers} />
      <Support items={siteConfig.supportItems} />
      <Footer memberUrl={siteConfig.memberUrl} billingPortalUrl={siteConfig.billingPortalUrl} />
    </main>
  )
}
