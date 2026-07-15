type SupportItem = {
  title: string
  detail: string
}

type SiteConfig = {
  brandName: string
  tagline: string
  priceLabel: string
  paymentLinkUrl: string
  memberUrl: string | null
  supportItems: ReadonlyArray<SupportItem>
}

type RawEnv = {
  VITE_PAYMENT_LINK_URL?: string
  VITE_MEMBER_URL?: string
}

export const DEFAULT_PAYMENT_LINK_URL = 'https://buy.stripe.com/test_28EaEW9nG7Zjb1Z6BE1VK00'

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
  priceLabel: '$8 / month',
  paymentLinkUrl: env.VITE_PAYMENT_LINK_URL ?? DEFAULT_PAYMENT_LINK_URL,
  memberUrl: env.VITE_MEMBER_URL ?? null,
  supportItems: SUPPORT_ITEMS,
})

const env: RawEnv = {
  VITE_PAYMENT_LINK_URL: import.meta.env.VITE_PAYMENT_LINK_URL,
  VITE_MEMBER_URL: import.meta.env.VITE_MEMBER_URL,
}

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem }
