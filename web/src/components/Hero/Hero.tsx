import styles from '@/components/Hero/Hero.module.scss'

type HeroProps = {
  brandName: string
  tagline: string
  priceLabel: string
  paymentLinkUrl: string
}

const Hero = ({ brandName, tagline, priceLabel, paymentLinkUrl }: HeroProps) => (
  <section className={styles.hero}>
    <h1 className={styles.brand}>{brandName}</h1>
    <p className={styles.tagline}>{tagline}</p>
    <p className={styles.price}>{priceLabel}</p>
    <a className={styles.cta} href={paymentLinkUrl}>
      Contribute
    </a>
  </section>
)

export default Hero
