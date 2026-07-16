import HeroLogo from '@/components/Hero/HeroLogo'
import styles from '@/components/Hero/Hero.module.scss'

type HeroProps = {
  brandName: string
  tagline: string
}

const Hero = ({ brandName, tagline }: HeroProps) => (
  <section className={styles.hero}>
    <HeroLogo />
    <h1 className={styles.brand}>{brandName}</h1>
    <p className={styles.tagline}>{tagline}</p>
    <a className={styles.cta} href="#pricing">
      Choose a plan
    </a>
  </section>
)

export default Hero
