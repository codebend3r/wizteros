import styles from './Footer.module.scss'

const MEMBER_LINK_LABEL = 'Already contributing? Access your account →'
const DISCLAIMER =
  'A contribution toward hosting and infrastructure costs, not a purchase of content.'

type FooterProps = {
  memberUrl: string | null
}

const Footer = ({ memberUrl }: FooterProps) => (
  <footer className={styles.footer}>
    {!!memberUrl && (
      <a className={styles.member} href={memberUrl}>
        {MEMBER_LINK_LABEL}
      </a>
    )}
    <p className={styles.disclaimer}>{DISCLAIMER}</p>
  </footer>
)

export default Footer
