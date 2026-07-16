type SupportItem = {
  title: string
  detail: string
}

type Tier = {
  id: 'bronze' | 'silver' | 'gold' | 'kids'
  name: string
  price: string
  cadence: string
  features: ReadonlyArray<string>
  paymentLinkUrl: string
}

type SiteConfig = {
  brandName: string
  tagline: string
  memberUrl: string | null
  supportItems: ReadonlyArray<SupportItem>
  tiers: ReadonlyArray<Tier>
}

type RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL?: string
  VITE_PAYMENT_LINK_SILVER_URL?: string
  VITE_PAYMENT_LINK_GOLD_URL?: string
  VITE_PAYMENT_LINK_KIDS_URL?: string
  VITE_MEMBER_URL?: string
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

export const resolveConfig = ({ env }: { env: RawEnv }): SiteConfig => ({
  brandName: 'Westeroz',
  tagline: 'A community-run media server. Contribute to the cost of keeping it online.',
  memberUrl: env.VITE_MEMBER_URL ?? null,
  supportItems: SUPPORT_ITEMS,
  tiers: [
    {
      id: 'bronze',
      name: 'Bronze',
      price: '$8',
      cadence: 'CAD / month',
      features: [
        'Standard streaming quality',
        'Watch on all your devices',
        'Request any show or movie',
      ],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_BRONZE_URL ?? '',
    },
    {
      id: 'silver',
      name: 'Silver',
      price: '$14',
      cadence: 'CAD / month',
      features: ['Everything in Bronze', '4K streaming support'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_SILVER_URL ?? '',
    },
    {
      id: 'gold',
      name: 'Gold',
      price: '$20',
      cadence: 'CAD / month',
      features: ['Everything in Silver', 'Offline downloads'],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_GOLD_URL ?? '',
    },
    {
      id: 'kids',
      name: 'Kids',
      price: '$20',
      cadence: 'CAD / month',
      features: [
        'Family plan curated for kids',
        '4K streaming support',
        'Offline downloads',
        'Request any kids show or movie',
      ],
      paymentLinkUrl: env.VITE_PAYMENT_LINK_KIDS_URL ?? '',
    },
  ],
})

const env: RawEnv = {
  VITE_PAYMENT_LINK_BRONZE_URL: import.meta.env.VITE_PAYMENT_LINK_BRONZE_URL,
  VITE_PAYMENT_LINK_SILVER_URL: import.meta.env.VITE_PAYMENT_LINK_SILVER_URL,
  VITE_PAYMENT_LINK_GOLD_URL: import.meta.env.VITE_PAYMENT_LINK_GOLD_URL,
  VITE_PAYMENT_LINK_KIDS_URL: import.meta.env.VITE_PAYMENT_LINK_KIDS_URL,
  VITE_MEMBER_URL: import.meta.env.VITE_MEMBER_URL,
}

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem, Tier }
