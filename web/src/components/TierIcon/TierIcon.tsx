import type { PaidTier } from '@/lib/adminApi'
import styles from '@/components/TierIcon/TierIcon.module.scss'

type TierIconProps = {
  tier: PaidTier
}

const TIER_CLASS: Record<PaidTier, string> = {
  bronze: styles.bronze,
  silver: styles.silver,
  gold: styles.gold,
  youth: styles.youth,
}

const TierIcon = ({ tier }: TierIconProps) => (
  <span className={`${styles.icon} ${TIER_CLASS[tier]}`} role="img" aria-label={`${tier} tier`} />
)

export default TierIcon
