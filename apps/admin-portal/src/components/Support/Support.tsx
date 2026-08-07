import type { SupportItem } from '@/site.config'
import styles from '@/components/Support/Support.module.scss'

type SupportProps = {
  items: ReadonlyArray<SupportItem>
}

export const Support = ({ items }: SupportProps) => (
  <section className={styles.support}>
    {items.map(({ title, detail }) => (
      <article key={title} className={styles.item}>
        <h2 className={styles.itemTitle}>{title}</h2>
        <p className={styles.itemDetail}>{detail}</p>
      </article>
    ))}
  </section>
)
