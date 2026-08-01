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

const FEATURE_LABELS = [
  'Access to all 1080p libraries',
  'Access to all 4K libraries',
  'Access to Lossless Music Library',
  'Offline downloads for travel',
  'Request any show or movie',
] as const

// Youth swaps the two library rows for youth-scoped wording; the remaining
// rows stay identical so the four cards keep their row-by-row alignment.
const YOUTH_FEATURE_LABELS = [
  'Access to all youth 1080p tv shows and movies',
  'Access to all 4K youth movies',
  'Access to Lossless Music Library',
  'Offline downloads for travel',
  'Request any show or movie',
] as const

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
  tagline: 'A community-run media server. Contribute to the cost of keeping it online.',
  memberUrl: env.VITE_MEMBER_URL ?? null,
  billingPortalUrl: env.VITE_BILLING_PORTAL_URL ?? null,
  stripeDashboardUrl: env.VITE_STRIPE_DASHBOARD_URL ?? null,
  supportItems: SUPPORT_ITEMS,
  tiers: [
    {
      id: 'bronze',
      name: 'Bronze',
      price: '$8',
      cadence: 'CAD / month',
      summary: 'The essentials to get streaming.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: [
          'Access to all 1080p libraries',
          'Access to Lossless Music Library',
          'Request any show or movie',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_BRONZE_URL ?? '',
    },
    {
      id: 'silver',
      name: 'Silver',
      price: '$14',
      cadence: 'CAD / month',
      summary: 'The full catalog in 4K.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: [
          'Access to all 1080p libraries',
          'Access to all 4K libraries',
          'Access to Lossless Music Library',
          'Request any show or movie',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_SILVER_URL ?? '',
    },
    {
      id: 'gold',
      name: 'Gold',
      price: '$20',
      cadence: 'CAD / month',
      summary: 'Everything the server offers.',
      features: toChecklist({
        labels: FEATURE_LABELS,
        included: [
          'Access to all 1080p libraries',
          'Access to all 4K libraries',
          'Access to Lossless Music Library',
          'Offline downloads for travel',
          'Request any show or movie',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_GOLD_URL ?? '',
    },
    {
      id: 'youth',
      name: 'Youth',
      price: '$10',
      cadence: 'CAD / month',
      summary: 'A family plan curated for youth.',
      features: toChecklist({
        labels: YOUTH_FEATURE_LABELS,
        included: [
          'Access to all youth 1080p tv shows and movies',
          'Access to all 4K youth movies',
          'Offline downloads for travel',
          'Request any show or movie',
        ],
      }),
      paymentLinkUrl: env.VITE_PAYMENT_LINK_YOUTH_URL ?? '',
    },
  ],
})

const env: RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL: import.meta.env.VITE_PAYMENT_LINK_BRONZE_URL,
  VITE_PAYMENT_LINK_SILVER_URL: import.meta.env.VITE_PAYMENT_LINK_SILVER_URL,
  VITE_PAYMENT_LINK_GOLD_URL: import.meta.env.VITE_PAYMENT_LINK_GOLD_URL,
  VITE_PAYMENT_LINK_YOUTH_URL: import.meta.env.VITE_PAYMENT_LINK_YOUTH_URL,
  VITE_MEMBER_URL: import.meta.env.VITE_MEMBER_URL,
  VITE_BILLING_PORTAL_URL: import.meta.env.VITE_BILLING_PORTAL_URL,
  VITE_STRIPE_DASHBOARD_URL: import.meta.env.VITE_STRIPE_DASHBOARD_URL,
}

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem, Tier }
