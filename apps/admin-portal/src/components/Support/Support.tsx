import type { SupportItem } from '@/site.config'
import styles from '@/components/Support/Support.module.scss'

type SupportProps = {
  items: ReadonlyArray<SupportItem>
}

const cardNumber = (index: number): string => String(index + 1).padStart(2, '0')

export const Support = ({ items }: SupportProps) => (
  <section id="where-it-goes" className={styles.support} aria-label="Where contributions go">
    {items.map(({ title, detail }, index) => (
      <article key={title} className={styles.item}>
        <p className={styles.number} aria-hidden="true">
          {cardNumber(index)}
        </p>
        <h2 className={styles.itemTitle}>{title}</h2>
        <p className={styles.itemDetail}>{detail}</p>
      </article>
    ))}
  </section>
)
