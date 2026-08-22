import { toAnnualPricing, type AnnualPricing } from '@/lib/billing'

type SupportItem = {
  title: string
  detail: string
}

type TierFeature = {
  label: string
  included: boolean
}

type Tier = {
  id: 'bronze' | 'silver' | 'gold' | 'youth'
  name: string
  price: string
  cadence: string
  summary: string
  features: ReadonlyArray<TierFeature>
  paymentLinkUrl: string
  // Derived from price, never hand-written. Only the hidden /annual preview
  // reads it today; the landing page stays on the monthly figures.
  annual: AnnualPricing
}

type SiteConfig = {
  brandName: string
  tagline: string
  memberUrl: string | null
  billingPortalUrl: string | null
  stripeDashboardUrl: string | null
  supportItems: ReadonlyArray<SupportItem>
  tiers: ReadonlyArray<Tier>
}

type RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL?: string
  VITE_PAYMENT_LINK_SILVER_URL?: string
  VITE_PAYMENT_LINK_GOLD_URL?: string
  VITE_PAYMENT_LINK_YOUTH_URL?: string
  // Annual links are their own Stripe prices. A cadence toggle that does not
  // carry its term into the checkout href is the classic annual-pricing bug:
  // the page says annual, the session opens monthly.
  VITE_PAYMENT_LINK_BRONZE_ANNUAL_URL?: string
  VITE_PAYMENT_LINK_SILVER_ANNUAL_URL?: string
  VITE_PAYMENT_LINK_GOLD_ANNUAL_URL?: string
  VITE_PAYMENT_LINK_YOUTH_ANNUAL_URL?: string
  VITE_MEMBER_URL?: string
  VITE_BILLING_PORTAL_URL?: string
  VITE_STRIPE_DASHBOARD_URL?: string
}

const SUPPORT_ITEMS: ReadonlyArray<SupportItem> = [
  {
    title: 'Server hardware',
    detail: 'Always-on machines that host and stream the platform.',
  },
  {
    title: 'Storage & bandwidth',
    detail: 'Disks and network capacity that keep everything available.',
  },
  {
    title: 'Maintenance & uptime',
    detail: 'Updates, backups, and monitoring so it stays reliable.',
  },
]

// Payment-surface copy stays on capability and infrastructure language
// (resolution, audio quality, downloads, profile scope). Never name content,
// titles, or libraries on a priced card.
const FEATURE_LABELS = [
  '1080p HD streaming',
  '4K UHD streaming',
  'Lossless audio streaming',
  'Offline downloads for travel',
  'Access to the request queue',
] as const

// Youth swaps the two playback rows for youth-profile wording; the remaining
// rows stay identical so the four cards keep their row-by-row alignment.
const YOUTH_FEATURE_LABELS = [
  '1080p HD streaming (youth profile)',
  '4K UHD streaming (youth profile)',
  'Lossless audio streaming',
  'Offline downloads for travel',
  'Access to the request queue',
] as const

// One source for each tier's monthly figure: the card quotes it directly and
// toAnnualPricing derives the annual column from it.
const PRICES = {
  bronze: '$8',
  silver: '$14',
  gold: '$20',
  youth: '$10',
} as const

const toChecklist = ({
  labels,
  included,
}: {
  labels: ReadonlyArray<string>
  included: ReadonlyArray<string>
}): ReadonlyArray<TierFeature> =>
  labels.map((label) => ({ label, included: included.includes(label) }))

export const resolveConfig = ({ env }: { env: RawEnv }): SiteConfig => ({
  brandName: 'Westeroz',
  tagline:
    'Get access to the media servers, kept online by the people who use them. ' +
    'Your contribution covers hosting, storage and bandwidth, nothing else.',
  memberUrl: env.VITE_MEMBER_URL ?? null,
  billingPortalUrl: env.VITE_BILLING_PORTAL_URL ?? null,
  stripeDashboardUrl: env.VITE_STRIPE_DASHBOARD_URL ?? null,
  supportItems: SUPPORT_ITEMS,
  tiers: [
    {
      id: 'bronze',
      name: 'Bronze',
      price: PRICES.bronze,
      cadence: 'CAD / month',
      summary: 'Everyday playback in 1080p.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: ['1080p HD streaming', 'Lossless audio streaming', 'Access to the request queue'],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_BRONZE_URL ?? '',
      annual: toAnnualPricing({
        price: PRICES.bronze,
        paymentLinkUrl: env.VITE_PAYMENT_LINK_BRONZE_ANNUAL_URL ?? '',
      }),
    },
    {
      id: 'silver',
      name: 'Silver',
      price: PRICES.silver,
      cadence: 'CAD / month',
      summary: 'Full 4K playback quality.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: [
          '1080p HD streaming',
          '4K UHD streaming',
          'Lossless audio streaming',
          'Access to the request queue',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_SILVER_URL ?? '',
      annual: toAnnualPricing({
        price: PRICES.silver,
        paymentLinkUrl: env.VITE_PAYMENT_LINK_SILVER_ANNUAL_URL ?? '',
      }),
    },
    {
      id: 'gold',
      name: 'Gold',
      price: PRICES.gold,
      cadence: 'CAD / month',
      summary: 'Everything the server offers.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: [
          '1080p HD streaming',
          '4K UHD streaming',
          'Lossless audio streaming',
          'Offline downloads for travel',
          'Access to the request queue',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_GOLD_URL ?? '',
      annual: toAnnualPricing({
        price: PRICES.gold,
        paymentLinkUrl: env.VITE_PAYMENT_LINK_GOLD_ANNUAL_URL ?? '',
      }),
    },
    {
      id: 'youth',
      name: 'Youth',
      price: PRICES.youth,
      cadence: 'CAD / month',
      summary: 'A youth profile with restricted defaults.',
      features: toChecklist({
        labels: YOUTH_FEATURE_LABELS,
        included: [
          '1080p HD streaming (youth profile)',
          '4K UHD streaming (youth profile)',
          'Offline downloads for travel',
          'Access to the request queue',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_YOUTH_URL ?? '',
      annual: toAnnualPricing({
        price: PRICES.youth,
        paymentLinkUrl: env.VITE_PAYMENT_LINK_YOUTH_ANNUAL_URL ?? '',
      }),
    },
  ],
})

const env: RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL: import.meta.env.VITE_PAYMENT_LINK_BRONZE_URL,
  VITE_PAYMENT_LINK_SILVER_URL: import.meta.env.VITE_PAYMENT_LINK_SILVER_URL,
  VITE_PAYMENT_LINK_GOLD_URL: import.meta.env.VITE_PAYMENT_LINK_GOLD_URL,
  VITE_PAYMENT_LINK_YOUTH_URL: import.meta.env.VITE_PAYMENT_LINK_YOUTH_URL,
  VITE_PAYMENT_LINK_BRONZE_ANNUAL_URL: import.meta.env.VITE_PAYMENT_LINK_BRONZE_ANNUAL_URL,
  VITE_PAYMENT_LINK_SILVER_ANNUAL_URL: import.meta.env.VITE_PAYMENT_LINK_SILVER_ANNUAL_URL,
  VITE_PAYMENT_LINK_GOLD_ANNUAL_URL: import.meta.env.VITE_PAYMENT_LINK_GOLD_ANNUAL_URL,
  VITE_PAYMENT_LINK_YOUTH_ANNUAL_URL: import.meta.env.VITE_PAYMENT_LINK_YOUTH_ANNUAL_URL,
  VITE_MEMBER_URL: import.meta.env.VITE_MEMBER_URL,
  VITE_BILLING_PORTAL_URL: import.meta.env.VITE_BILLING_PORTAL_URL,
  VITE_STRIPE_DASHBOARD_URL: import.meta.env.VITE_STRIPE_DASHBOARD_URL,
}

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem, Tier }
