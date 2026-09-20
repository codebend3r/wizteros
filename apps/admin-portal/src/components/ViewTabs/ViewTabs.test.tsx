import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from '@/test/vi'
import { ViewTabs } from '@/components/ViewTabs/ViewTabs'
import { METRIC_COPY } from '@/pages/Fleet/metricCopy'
import { CHART_KINDS } from '@/stores/fleetPrefsStore'

const TABS = CHART_KINDS.map((id) => ({
  id,
  title: METRIC_COPY[id].title,
  icon: METRIC_COPY[id].icon,
}))

const renderTabs = (action?: { label: string; icon: 'expand' | 'collapse'; onClick: () => void }) =>
  render(
    <ViewTabs tabs={TABS} active="cpu" onSelect={vi.fn()} label="Fleet charts" action={action}>
      <p>panel</p>
    </ViewTabs>,
  )

// The glyph is a faster handle on the same word, never a replacement for it:
// the tab's name stays the metric's title, and the icon stays out of it.
test('ViewTabs draws a hidden icon in every tab without changing the tab name', () => {
  renderTabs()

  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['CPU', 'Memory', 'Network', 'GPU'])
  expect(tabs.every((tab) => tab.querySelector('svg[aria-hidden="true"]') !== null)).toBe(true)
})

// The one icon-only control on the page: its name has to reach both a screen
// reader and a pointer hovering over it, and it still has to do its job.
test('ViewTabs names its icon-only action for assistive tech and the pointer alike', () => {
  const onClick = vi.fn()
  renderTabs({ label: 'Expand chart', icon: 'expand', onClick })

  const action = screen.getByRole('button', { name: 'Expand chart' })
  expect(action.textContent).toBe('')
  expect(action).toHaveAttribute('title', 'Expand chart')
  expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

  fireEvent.click(action)
  expect(onClick).toHaveBeenCalledTimes(1)
})

// Two strips on one page must not both mint the same tab id, or one strip's
// tab would point at the other strip's panel.
test('ViewTabs points each tab at its own panel', () => {
  renderTabs()

  const [cpu] = screen.getAllByRole('tab')
  const panel = screen.getByRole('tabpanel')
  expect(cpu?.getAttribute('aria-controls')).toBe(panel.getAttribute('id'))
  expect(panel.getAttribute('aria-labelledby')).toBe(cpu?.getAttribute('id'))
})
