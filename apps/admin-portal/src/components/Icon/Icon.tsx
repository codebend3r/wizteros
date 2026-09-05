import type { ReactElement } from 'react'

/** Every glyph the admin pages draw, named for the thing it stands for. */
export type IconName =
  | 'box'
  | 'check'
  | 'chevron'
  | 'collapse'
  | 'cpu'
  | 'disk'
  | 'expand'
  | 'gauge'
  | 'gpu'
  | 'help'
  | 'history'
  | 'memory'
  | 'network'
  | 'pulse'
  | 'refresh'
  | 'warn'

// One 16-unit grid, strokes only, round caps and joins: the geometry every
// glyph shares, so the set reads as one hand whatever size it is shown at. The
// single filled mark (the disk's indicator dot) says so inline.
const GLYPHS: Record<IconName, ReactElement> = {
  box: (
    <>
      <path d="M2 5.5l6-3 6 3v6l-6 3-6-3z" />
      <path d="M2 5.5l6 3 6-3M8 8.5v6" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.25l2 2 4-4.5" />
    </>
  ),
  chevron: <path d="M4 6l4 4 4-4" />,
  collapse: <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5l-4-4M9.5 9.5l4 4" />,
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <rect x="6.5" y="6.5" width="3" height="3" />
      <path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5" />
    </>
  ),
  disk: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 9h13" />
      <circle cx="11.75" cy="11.25" r="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  expand: <path d="M2.5 6V2.5H6M13.5 10v3.5H10M2.5 2.5l4 4M13.5 13.5l-4-4" />,
  gauge: (
    <>
      <path d="M2 12.5a6 6 0 1 1 12 0" />
      <path d="M8 12.5l3-4" />
      <circle cx="8" cy="12.5" r="1" />
    </>
  ),
  gpu: (
    <>
      <rect x="1.5" y="3.5" width="13" height="8" rx="1" />
      <circle cx="8" cy="7.5" r="2.25" />
      <path d="M3.5 11.5v2M6.5 11.5v2M9.5 11.5v2M12.5 11.5v2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6 6.5a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M8 12v.25" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.5 2.5v3h3" />
      <path d="M8 5v3.25l2 1.25" />
    </>
  ),
  memory: (
    <>
      <rect x="1.5" y="4.5" width="13" height="6" rx="1" />
      <path d="M4.5 6.5v2M8 6.5v2M11.5 6.5v2M3.5 10.5v2M8 10.5v2M12.5 10.5v2" />
    </>
  ),
  network: <path d="M5 13.5V3M2.5 5.5L5 3l2.5 2.5M11 2.5V13M8.5 10.5L11 13l2.5-2.5" />,
  pulse: <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />,
  refresh: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </>
  ),
  warn: (
    <>
      <path d="M8 2.5l6 11H2z" />
      <path d="M8 6.5v3M8 11.25v.25" />
    </>
  ),
}

type IconProps = {
  readonly name: IconName
  /** Rendered size in px. The drawing scales from its 16-unit grid. */
  readonly size?: number
  /** Stroke in grid units, so it scales with the size: 1.5 is the hairline at
      16px, and a tile's glyph takes 1.75 to hold its weight over a tint. */
  readonly strokeWidth?: number
  readonly className?: string
}

/** An inline glyph, always decorative.
 *
 * Every icon on these pages sits beside the word it stands for, so the drawing
 * is hidden from assistive tech and marked unfocusable: an inline SVG is a tab
 * stop of its own in older engines, and a stop that announces nothing is worse
 * than none. A control that shows only an icon names itself with `aria-label`.
 */
export const Icon = ({ name, size = 16, strokeWidth = 1.5, className }: IconProps) => (
  <svg
    aria-hidden="true"
    focusable="false"
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {GLYPHS[name]}
  </svg>
)
