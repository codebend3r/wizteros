import { TierIcon } from '@/components/TierIcon/TierIcon'
import { plural } from '@/lib/fleetApi'
import {
  formatMoney,
  monthLabel,
  tierPrice,
  type CurrentIncome,
  type IncomeMonth,
} from '@/lib/income'
import { PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import styles from '@/pages/Income/IncomeHero.module.scss'

type IncomeHeroProps = {
  readonly income: CurrentIncome
  /** Last month's row, for the change line. Absent while there is no last month. */
  readonly previous?: IncomeMonth
}

/** The one number the page leads with, and the arithmetic behind it. */
export const IncomeHero = ({ income, previous }: IncomeHeroProps) => {
  const delta = previous === undefined ? null : income.total - previous.income
  return (
    <section className={styles.hero} aria-labelledby="income-hero">
      <h2 className={styles.label} id="income-hero">
        Monthly income
      </h2>
      <p className={styles.figure}>
        <span className={styles.amount}>{formatMoney(income.total)}</span>
        <span className={styles.per}>per month</span>
      </p>
      <ul className={styles.qualifiers}>
        <li className={styles.qualifier}>
          {plural({ count: income.paying, unit: 'paying member' })}
        </li>
        {delta !== null &&
          previous !== undefined && (
            // The sign is stated, so the colour only underlines it.
            <li className={delta < 0 ? styles.down : styles.up}>
              {delta < 0 ? '-' : '+'}
              {formatMoney(Math.abs(delta))} vs {monthLabel(previous.month)}
            </li>
          )}
        {income.atRisk.count > 0 && (
          <li className={styles.risk}>
            {formatMoney(income.atRisk.amount)} at risk:{' '}
            {plural({ count: income.atRisk.count, unit: 'payment' })} failing
          </li>
        )}
        {income.untiered > 0 && (
          <li className={styles.qualifier}>
            {income.untiered} subscribed with no tier on record, not counted
          </li>
        )}
      </ul>
      <ul className={styles.tiers} aria-label="By tier">
        {PAID_TIERS.map((tier) => (
          <li key={tier} className={styles.tile}>
            <span className={styles.tileLabel}>
              <TierIcon tier={tier} /> {TIER_LABELS[tier]}
            </span>
            <span className={styles.tileFigure}>{formatMoney(income.byTier[tier].amount)}</span>
            <span className={styles.tileQualifier}>
              {income.byTier[tier].count} × {formatMoney(tierPrice({ tier }))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
