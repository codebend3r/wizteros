import { useEffect } from 'react'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { Footer } from '@/components/Footer/Footer'
import { Hero } from '@/components/Hero/Hero'
import { Pricing } from '@/components/Pricing/Pricing'
import { StatusBoard } from '@/components/StatusBoard/StatusBoard'
import { Support } from '@/components/Support/Support'
import { ANNUAL_MONTHS_FREE, fromPrice } from '@/lib/billing'
import { siteConfig } from '@/site.config'
import { useBillingStore } from '@/stores/billingStore'
import styles from '@/pages/AnnualPreview/AnnualPreview.module.scss'

// Unlisted on purpose: this route is not in menuRoutes and nothing links to
// it. It renders the real landing page rather than a mock-up, so the cadence
// switch can be judged against the surface it would actually ship on.

const BANNER = {
  label: 'Preview',
  detail:
    'Annual pricing is not live. This route exists to judge the look, the numbers, and the wording before any of it ships.',
} as const

const NOTES = [
  {
    title: `${ANNUAL_MONTHS_FREE} months free, 16.7% off`,
    detail:
      'The usual band is 15 to 25 percent. Below roughly 10 percent nobody prepays; above roughly 25 percent the monthly figure starts to read as a penalty and people learn to hold out for a better number. Ten months charged lands mid-band and keeps every tier on whole dollars.',
  },
  {
    title: 'The month figure leads, the year total stays on screen',
    detail:
      'The card quotes the monthly equivalent with "billed annually" attached, keeps the monthly figure struck through beside it, and states the single charge under the button. Putting a yearly total where a monthly one belongs is the error teams keep shipping and then reverting.',
  },
  {
    title: 'Monthly is never the quiet option',
    detail:
      'Neither cadence is preselected for the reader and both sit at the same weight and contrast. Defaulting to annual while the monthly option is small and grey is the shape regulators have been acting on.',
  },
  {
    title: 'The cadence has to reach the checkout',
    detail:
      'Each tier carries its own annual payment link, so the switch changes the href and not just the number on screen. A toggle that moves the price but not the link opens a monthly session and takes the wrong amount.',
  },
  {
    title: 'What a yearly term changes',
    detail:
      'Prepaid terms lapse far less often than month-to-month ones, and the money lands up front, which is the half of the year the hardware bill does not wait for. The trade is that fewer people commit at all, which is why both cadences stay on the page.',
  },
] as const

const OPEN_QUESTIONS = [
  'Do the four annual figures read as fair, or does Gold at $200 need its own framing?',
  'Should Youth be offered annually at all, or stay month-to-month for households that change?',
  'Is "access runs to the end of the paid year" the promise we want to make on cancellation?',
  'Annual Stripe prices and their payment links do not exist yet; the CTA stays hidden until they do.',
] as const

const PreviewNotes = () => (
  <section className={styles.notes} aria-labelledby="annual-notes-title">
    <header className={styles.notesHeader}>
      <h2 className={styles.notesTitle} id="annual-notes-title">
        Why it is shaped this way
      </h2>
      <p className={styles.notesLead}>
        Each choice below is a decision, not a default. Argue with any of them.
      </p>
    </header>
    <ul className={styles.noteList}>
      {NOTES.map(({ title, detail }) => (
        <li key={title} className={styles.note}>
          <h3 className={styles.noteTitle}>{title}</h3>
          <p className={styles.noteDetail}>{detail}</p>
        </li>
      ))}
    </ul>
    <h3 className={styles.openTitle}>Still open</h3>
    <ul className={styles.openList}>
      {OPEN_QUESTIONS.map((question) => (
        <li key={question} className={styles.openItem}>
          {question}
        </li>
      ))}
    </ul>
  </section>
)

const AnnualPreviewPage = () => {
  const cadence = useBillingStore((state) => state.cadence)
  const setCadence = useBillingStore((state) => state.setCadence)

  // The cadence is global so the ledger and the marquee follow the switch.
  // Resetting on the way out keeps the live landing page on monthly, which is
  // the only cadence its payment links currently back.
  useEffect(() => () => setCadence({ cadence: 'monthly' }), [setCadence])

  return (
    <main className={styles.page}>
      <aside className={styles.banner} aria-label="Preview notice">
        <span className={styles.bannerLabel}>{BANNER.label}</span>
        <p className={styles.bannerDetail}>{BANNER.detail}</p>
      </aside>
      <Hero
        brandName={siteConfig.brandName}
        tagline={siteConfig.tagline}
        memberUrl={siteConfig.memberUrl}
        fromPrice={fromPrice({ tiers: siteConfig.tiers, cadence })}
      />
      <Pricing tiers={siteConfig.tiers} preview />
      <StatusBoard tiers={siteConfig.tiers} />
      <Support items={siteConfig.supportItems} />
      <PreviewNotes />
      <Footer memberUrl={siteConfig.memberUrl} billingPortalUrl={siteConfig.billingPortalUrl} />
    </main>
  )
}

export const AnnualPreview = () => (
  <AdminGate title="Westeroz: Annual pricing preview">
    <AnnualPreviewPage />
  </AdminGate>
)
