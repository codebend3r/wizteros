import type { Tier } from '@/site.config'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
}

const Pricing = ({ tiers }: PricingProps) => (
  <section id="pricing" className={styles.pricing}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>Membership</p>
      <h2 className={styles.title}>Choose your tier</h2>
      <p className={styles.subtitle}>
        A monthly contribution toward hosting, storage, and bandwidth.
      </p>
    </header>
    <div className={styles.grid}>
      {tiers.map(({ id, name, price, cadence, features, paymentLinkUrl }) => (
        <article key={id} className={`${styles.card} ${styles[id]}`}>
          <h3 className={styles.name}>{name}</h3>
          <p className={styles.price}>
            {price}
            <span className={styles.cadence}>{cadence}</span>
          </p>
          <ul className={styles.features}>
            {features.map((feature) => (
              <li key={feature} className={styles.feature}>
                {feature}
              </li>
            ))}
          </ul>
          {!!paymentLinkUrl && (
            <a className={styles.cta} href={paymentLinkUrl}>
              Choose {name}
            </a>
          )}
        </article>
      ))}
    </div>
  </section>
)

export default Pricing
