import Hero from '@/components/Hero/Hero'
import Pricing from '@/components/Pricing/Pricing'
import Support from '@/components/Support/Support'
import Footer from '@/components/Footer/Footer'
import { siteConfig } from '@/site.config'
import styles from '@/App.module.scss'

const App = () => (
  <main className={styles.page}>
    <Hero brandName={siteConfig.brandName} tagline={siteConfig.tagline} />
    <Pricing tiers={siteConfig.tiers} />
    <Support items={siteConfig.supportItems} />
    <Footer memberUrl={siteConfig.memberUrl} billingPortalUrl={siteConfig.billingPortalUrl} />
  </main>
)

export default App
