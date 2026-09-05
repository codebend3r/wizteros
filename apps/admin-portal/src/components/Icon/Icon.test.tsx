import { render } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import { Icon } from '@/components/Icon/Icon'

// Every icon on the admin pages sits beside the word it stands for, so the
// glyph itself is decoration: hidden from assistive tech, and never a tab stop
// of its own the way an inline SVG is in older engines.
test('Icon is decorative: hidden from assistive tech and never focusable', () => {
  const { container } = render(<Icon name="cpu" />)

  const svg = container.querySelector('svg')
  expect(svg).toHaveAttribute('aria-hidden', 'true')
  expect(svg).toHaveAttribute('focusable', 'false')
})

// One grid for every glyph, so a set drawn at 16 and shown at 20 keeps the
// same stroke geometry rather than each icon carrying its own coordinates.
test('Icon draws on a 16px grid by default and scales to the size it is given', () => {
  const { container } = render(
    <>
      <Icon name="cpu" />
      <Icon name="gpu" size={20} />
    </>,
  )

  const [small, large] = container.querySelectorAll('svg')
  expect(small).toHaveAttribute('width', '16')
  expect(small).toHaveAttribute('viewBox', '0 0 16 16')
  expect(large).toHaveAttribute('width', '20')
  expect(large).toHaveAttribute('viewBox', '0 0 16 16')
})
