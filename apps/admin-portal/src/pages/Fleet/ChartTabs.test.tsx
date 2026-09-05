import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from '@/test/vi'
import { ChartTabs } from '@/pages/Fleet/ChartTabs'
import { CHART_KINDS } from '@/stores/fleetPrefsStore'

const renderTabs = (action?: { label: string; icon: 'expand' | 'collapse'; onClick: () => void }) =>
  render(
    <ChartTabs kinds={CHART_KINDS} active="cpu" onSelect={vi.fn()} action={action}>
      <p>panel</p>
    </ChartTabs>,
  )

// The glyph is a faster handle on the same word, never a replacement for it:
// the tab's name stays the metric's title, and the icon stays out of it.
test('ChartTabs draws a hidden icon in every tab without changing the tab name', () => {
  renderTabs()

  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['CPU', 'Memory', 'Network', 'GPU'])
  expect(tabs.every((tab) => tab.querySelector('svg[aria-hidden="true"]') !== null)).toBe(true)
})

// The one icon-only control on the page: its name has to reach both a screen
// reader and a pointer hovering over it, and it still has to do its job.
test('ChartTabs names its icon-only action for assistive tech and the pointer alike', () => {
  const onClick = vi.fn()
  renderTabs({ label: 'Expand chart', icon: 'expand', onClick })

  const action = screen.getByRole('button', { name: 'Expand chart' })
  expect(action.textContent).toBe('')
  expect(action).toHaveAttribute('title', 'Expand chart')
  expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

  fireEvent.click(action)
  expect(onClick).toHaveBeenCalledTimes(1)
})
