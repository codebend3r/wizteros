import { formatMoney, monthLabel, type IncomeMonth } from '@/lib/income'
import styles from '@/pages/Income/chart.module.scss'

type IncomeTableProps = {
  readonly months: readonly IncomeMonth[]
}

const COLUMNS = [
  { key: 'income', label: 'Income', money: true },
  { key: 'members', label: 'Members', money: false },
  { key: 'signups', label: 'Signups', money: true },
  { key: 'upgrades', label: 'Upgrades', money: true },
  { key: 'downgrades', label: 'Downgrades', money: true },
  { key: 'churn', label: 'Cancellations', money: true },
  { key: 'outages', label: 'Outages', money: false },
  { key: 'paymentFailures', label: 'Payments failed', money: false },
] as const

/** Every number both charts draw, as a table: the reading that needs no
    colour, no hover, and no eyesight for a 2px line. */
export const IncomeTable = ({ months }: IncomeTableProps) => (
  <details className={styles.details}>
    <summary className={styles.summary}>View as table</summary>
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label="Income by month">
        <thead>
          <tr>
            <th scope="col">Month</th>
            {COLUMNS.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr key={month.month}>
              <th scope="row">{monthLabel(month.month)}</th>
              {COLUMNS.map((column) => (
                <td key={column.key}>
                  {column.money ? formatMoney(month[column.key]) : month[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </details>
)
