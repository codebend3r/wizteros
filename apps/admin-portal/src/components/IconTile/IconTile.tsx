import { Icon, type IconName } from '@/components/Icon/Icon'
import styles from '@/components/IconTile/IconTile.module.scss'

/** Whose colour the tile wears: the host's series colour beside a reading,
    the healthy green on a status, muted on inventory and toolbar marks. */
export type IconTileTone = 'muted' | 'ok' | 'series'

/** Inventory rows and the status pill, the toolbar marks, the readings. */
export type IconTileSize = 'sm' | 'md' | 'lg'

type IconTileProps = {
  readonly name: IconName
  readonly tone: IconTileTone
  readonly size?: IconTileSize
  readonly className?: string
}

const TONE_CLASS: Record<IconTileTone, string> = {
  muted: styles.muted,
  ok: styles.ok,
  series: styles.series,
}

const SIZE_CLASS: Record<IconTileSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
}

// The glyph takes a little over half the tile at every size, so the tint
// around it stays a frame rather than a sliver.
const GLYPH_PX: Record<IconTileSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
}

/** A tinted square carrying one glyph.
 *
 * The tile restates, in colour and shape, facts the text beside it already
 * carries: the label names the reading, and the card border names the host.
 * So it is hidden whole, glyph included, rather than announced twice.
 */
export const IconTile = ({ name, tone, size = 'md', className }: IconTileProps) => {
  const base = `${styles.tile} ${TONE_CLASS[tone]} ${SIZE_CLASS[size]}`
  return (
    <span className={className === undefined ? base : `${base} ${className}`} aria-hidden="true">
      <Icon name={name} size={GLYPH_PX[size]} strokeWidth={1.75} />
    </span>
  )
}
