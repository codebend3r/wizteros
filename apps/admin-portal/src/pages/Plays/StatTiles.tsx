import type { IconName } from '@/components/Icon/Icon'
import { IconTile } from '@/components/IconTile/IconTile'
import styles from '@/pages/Plays/StatTiles.module.scss'

export type StatTile = {
  readonly label: string
  readonly value: string
  /** What scopes the figure, under it; omitted when the label says it all. */
  readonly qualifier?: string
  readonly icon: IconName
}

type StatTilesProps = {
  readonly tiles: readonly StatTile[]
  /** The list's accessible name. */
  readonly label: string
}

/** The four figures the overview leads with, as three tiers each: what it
    is, what it says, what it is measured against. The tile ahead is a faster
    handle on the label, not a fourth tier, and is hidden whole. */
export const StatTiles = ({ tiles, label }: StatTilesProps) => (
  <dl className={styles.tiles} aria-label={label}>
    {tiles.map((tile) => (
      <div key={tile.label} className={styles.tile}>
        <IconTile name={tile.icon} tone="muted" size="lg" className={styles.mark} />
        <dt className={styles.label}>{tile.label}</dt>
        <dd className={styles.value}>
          <span className={styles.figure}>{tile.value}</span>
          {tile.qualifier !== undefined && (
            <span className={styles.qualifier}>{tile.qualifier}</span>
          )}
        </dd>
      </div>
    ))}
  </dl>
)
