import { render } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import { IconTile } from '@/components/IconTile/IconTile'

// The tile restates, in colour, a fact the text beside it already carries: it
// is hidden whole, glyph and all, so a reader never hears it twice.
test('IconTile is decorative and wears the tone and size it is given', () => {
  const { container } = render(<IconTile name="memory" tone="series" size="lg" />)

  const tile = container.firstElementChild
  expect(tile).toHaveAttribute('aria-hidden', 'true')
  expect(tile).toHaveClass('tile', 'series', 'lg')
  expect(tile?.querySelector('svg')).not.toBeNull()
})

test('IconTile defaults to the middle size', () => {
  const { container } = render(<IconTile name="history" tone="muted" />)

  expect(container.firstElementChild).toHaveClass('md')
})
