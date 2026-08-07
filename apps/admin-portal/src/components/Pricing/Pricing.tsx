import type { Tier } from '@/site.config'
import styles from '@/components/Pricing/Pricing.module.scss'

type PricingProps = {
  tiers: ReadonlyArray<Tier>
}

const CHECK_PATH = 'M3.5 8.5 6.5 11.5 12.5 4.5'
const CROSS_PATH = 'M4.5 4.5 11.5 11.5 M11.5 4.5 4.5 11.5'

export const Pricing = ({ tiers }: PricingProps) => (
  <section id="pricing" className={styles.pricing}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>Membership</p>
      <h2 className={styles.title}>Choose your tier</h2>
      <p className={styles.subtitle}>
        A monthly contribution toward hosting, storage, and bandwidth.
      </p>
    </header>
    <div className={styles.grid}>
      {tiers.map(({ id, name, price, cadence, summary, features, paymentLinkUrl }) => (
        <article key={id} className={`${styles.card} ${styles[id]}`}>
          <h3 className={styles.name}>{name}</h3>
          <p className={styles.price}>
            {price}
            <span className={styles.cadence}>{cadence}</span>
          </p>
          <p className={styles.summary}>{summary}</p>
          <ul className={styles.features}>
            {features.map(({ label, included }) => (
              <li
                key={label}
                className={`${styles.feature} ${included ? styles.included : styles.excluded}`}
              >
                <svg className={styles.mark} viewBox="0 0 16 16" aria-hidden="true">
                  <path d={included ? CHECK_PATH : CROSS_PATH} />
                </svg>
                <span className={styles.srOnly}>{included ? 'Included:' : 'Not included:'}</span>
                <span className={styles.label}>{label}</span>
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
