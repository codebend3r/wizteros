import styles from '@/components/Footer/Footer.module.scss'

const MEMBER_LINK_LABEL = 'Already contributing? Access your account →'
const MANAGE_LINK_LABEL = 'Manage or cancel your monthly contribution'
const DISCLAIMER =
  'A contribution toward hosting and infrastructure costs, not a purchase of content.'

type FooterProps = {
  memberUrl: string | null
  billingPortalUrl: string | null
}

export const Footer = ({ memberUrl, billingPortalUrl }: FooterProps) => (
  <footer className={styles.footer}>
    {!!memberUrl && (
      <a className={styles.member} href={memberUrl}>
        {MEMBER_LINK_LABEL}
      </a>
    )}
    {!!billingPortalUrl && (
      <a className={styles.manage} href={billingPortalUrl}>
        {MANAGE_LINK_LABEL}
      </a>
    )}
    <p className={styles.disclaimer}>{DISCLAIMER}</p>
  </footer>
)
