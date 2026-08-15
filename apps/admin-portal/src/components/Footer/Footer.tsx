import styles from '@/components/Footer/Footer.module.scss'

const MEMBER_LINK_LABEL = 'Already contributing? Access your account →'
const MANAGE_LINK_LABEL = 'Manage or cancel your monthly contribution'
const DISCLAIMER =
  'A contribution toward hosting and infrastructure costs, not a purchase of content.'
const CONTACT_EMAIL = 'chester.rivas@gmail.com'

type FooterProps = {
  memberUrl: string | null
  billingPortalUrl: string | null
  // The amber band closes the marketing page; the admin keeps a quiet navy
  // footer because amber is a marketing device, not admin chrome.
  tone?: 'band' | 'quiet'
}

export const Footer = ({ memberUrl, billingPortalUrl, tone = 'band' }: FooterProps) => (
  <footer className={tone === 'band' ? styles.band : styles.quiet}>
    <div className={styles.account}>
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
    </div>
    <div className={styles.fineprint}>
      <p className={styles.disclaimer}>{DISCLAIMER}</p>
      <a className={styles.contact} href={`mailto:${CONTACT_EMAIL}`}>
        {CONTACT_EMAIL}
      </a>
    </div>
  </footer>
)
