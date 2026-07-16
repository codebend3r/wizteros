import type { Tier } from '@/site.config'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
}

const Pricing = ({ tiers }: PricingProps) => (
  <section id="pricing" className={styles.pricing}>
    {tiers.map(({ id, name, priceLabel, features, paymentLinkUrl }) => (
      <article key={id} className={styles.card}>
        <h2 className={styles.name}>{name}</h2>
        <p className={styles.price}>{priceLabel}</p>
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
  </section>
)

export default Pricing
