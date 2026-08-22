import { ANNUAL_MONTHS_FREE, type BillingCadence } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import styles from '@/components/BillingToggle/BillingToggle.module.scss'

type Option = {
  value: BillingCadence
  label: string
  note: string | null
}

const OPTIONS: ReadonlyArray<Option> = [
  { value: 'monthly', label: 'Monthly', note: null },
  { value: 'annual', label: 'Annual', note: `${ANNUAL_MONTHS_FREE} months free` },
]

// Both cadences stay equally legible and neither is preselected for the
// reader: the saving is stated on the annual option rather than hidden in a
// default. Burying the monthly option is the pattern regulators have been
// fining, and it is the wrong shape for a contribution anyway.
const HINTS: Record<BillingCadence, string> = {
  monthly: 'Charged every month. Cancel any time from the billing portal.',
  annual:
    'One charge covers the next twelve months. Cancel any time; access runs to the end of the year you paid for.',
}

export const BillingToggle = () => {
  const cadence = useBillingStore((state) => state.cadence)
  const setCadence = useBillingStore((state) => state.setCadence)

  return (
    <fieldset className={styles.toggle}>
      <legend className={styles.legend}>Billing cadence</legend>
      <div className={styles.options}>
        {OPTIONS.map(({ value, label, note }) => (
          <label
            key={value}
            className={
              value === cadence ? `${styles.option} ${styles.optionSelected}` : styles.option
            }
          >
            <input
              className={styles.input}
              type="radio"
              name="billing-cadence"
              value={value}
              checked={value === cadence}
              onChange={() => setCadence({ cadence: value })}
            />
            <span className={styles.optionLabel}>{label}</span>
            {!!note && <span className={styles.note}>{note}</span>}
          </label>
        ))}
      </div>
      <p className={styles.hint}>{HINTS[cadence]}</p>
    </fieldset>
  )
}
