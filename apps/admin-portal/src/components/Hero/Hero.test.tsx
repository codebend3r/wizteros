import { expect, test } from '@/test/vi'
import { fireEvent, render, screen } from '@testing-library/react'
import { Hero } from '@/components/Hero/Hero'

const props = {
  brandName: 'Westeroz',
  tagline: 'Get access to the media servers.',
  memberUrl: null,
  fromPrice: '$8',
}

test('renders the headline, brand, and tagline with a link to pricing', () => {
  render(<Hero {...props} />)
  expect(
    screen.getByRole('heading', { name: "Everything you'd stream. Nothing you'd skip." }),
  ).toBeInTheDocument()
  expect(screen.getByText('Westeroz')).toBeInTheDocument()
  expect(screen.getByText('Get access to the media servers.')).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: 'Choose a plan' })
  expect(cta).toHaveAttribute('href', '#pricing')
})

test('anchors the section nav to the page sections', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '#status')
  expect(screen.getByRole('link', { name: 'Tiers' })).toHaveAttribute('href', '#pricing')
  expect(screen.getByRole('link', { name: 'Where it goes' })).toHaveAttribute(
    'href',
    '#where-it-goes',
  )
})

test('captions the CTA with the cheapest tier price', () => {
  render(<Hero {...props} />)
  expect(screen.getByText('From $8 CAD / month · Cancel any time')).toBeInTheDocument()
})

test('hides the sign-in link without a member url', () => {
  render(<Hero {...props} />)
  expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
})

test('links sign-in to the member url when provided', () => {
  render(<Hero {...props} memberUrl="https://app.plex.tv" />)
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    'https://app.plex.tv',
  )
})

const tickerRows = (container: HTMLElement) =>
  [...container.querySelectorAll('.tickerRow')].map((row) =>
    [...row.querySelectorAll('.tickerItem')].map(
      (item) => `${item.textContent}|${tickerTone(item)}`,
    ),
  )

const labelsOf = (row: ReadonlyArray<string> | undefined) =>
  (row ?? []).map((entry) => entry.split('|')[0]).sort()

const TONES = ['toneGold', 'toneGreen', 'toneRose'] as const

const tickerTone = (item: Element) => TONES.filter((tone) => item.classList.contains(tone)).join()

const tickerTrack = (container: HTMLElement) => {
  const track = container.querySelector('.tickerTrack')
  if (!track) throw new Error('missing ticker track')
  return track
}

test('renders the trailing ticker row in a different order from the leading row', () => {
  const { container } = render(<Hero {...props} />)
  const [lead, trail] = tickerRows(container)
  expect(trail).not.toEqual(lead)
  expect(labelsOf(lead)).toEqual(labelsOf(trail))
})

test('hands the trailing ticker order to the leading row on every animation pass', () => {
  const { container } = render(<Hero {...props} />)
  const [, trailBefore] = tickerRows(container)
  fireEvent.animationIteration(tickerTrack(container))
  const [leadAfter, trailAfter] = tickerRows(container)
  expect(leadAfter).toEqual(trailBefore)
  expect(trailAfter).not.toEqual(leadAfter)
})

test('paints every ticker item in exactly one of three tones', () => {
  const { container } = render(<Hero {...props} />)
  const items = [...container.querySelectorAll('.tickerItem')]
  expect(items.length).toBeGreaterThan(0)
  const tones = items.map(tickerTone)
  expect(tones.every((tone) => TONES.some((known) => known === tone))).toBe(true)
  expect(new Set(tones).size).toBeGreaterThan(1)
})
