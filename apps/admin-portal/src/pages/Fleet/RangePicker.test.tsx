import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from '@/test/vi'
import { RangePicker } from '@/pages/Fleet/RangePicker'

test('RangePicker offers every range, widest first', () => {
  render(<RangePicker minutes={60} onChange={vi.fn()} />)

  const group = screen.getByRole('group', { name: 'CPU history range' })
  const labels = screen.getAllByRole('button').map((button) => button.textContent)
  expect(group).toBeInTheDocument()
  expect(labels).toEqual([
    '1 week',
    '3 days',
    '1 day',
    '12 hours',
    '6 hours',
    '1 hour',
    '15 minutes',
  ])
})

test('RangePicker marks the chosen range pressed, never by colour alone', () => {
  render(<RangePicker minutes={1440} onChange={vi.fn()} />)

  expect(screen.getByRole('button', { name: '1 day' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '1 hour' })).toHaveAttribute('aria-pressed', 'false')
})

// The mark names the group at a glance; the group's own label still does so
// for a reader, and the mark is neither a stop nor a button among the ranges.
test('RangePicker leads with a history mark that is neither a button nor announced', () => {
  render(<RangePicker minutes={60} onChange={vi.fn()} />)

  const group = screen.getByRole('group', { name: 'CPU history range' })
  expect(group.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  expect(screen.getAllByRole('button')).toHaveLength(7)
})

test('RangePicker reports the range a click chose in minutes', async () => {
  const onChange = vi.fn()
  render(<RangePicker minutes={60} onChange={onChange} />)

  await userEvent.click(screen.getByRole('button', { name: '1 week' }))

  expect(onChange).toHaveBeenCalledWith(10_080)
})
