import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from '@/test/vi'
import { RangePicker } from '@/pages/Fleet/RangePicker'

test('RangePicker offers every range, widest first', () => {
  render(<RangePicker minutes={60} onChange={vi.fn()} />)

  const group = screen.getByRole('group', { name: 'CPU history range' })
  const labels = screen.getAllByRole('button').map((button) => button.textContent)
  expect(group).toBeInTheDocument()
  expect(labels).toEqual(['1 week', '3 days', '1 day', '12 hours', '6 hours', '1 hour'])
})

test('RangePicker marks the chosen range pressed, never by colour alone', () => {
  render(<RangePicker minutes={1440} onChange={vi.fn()} />)

  expect(screen.getByRole('button', { name: '1 day' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '1 hour' })).toHaveAttribute('aria-pressed', 'false')
})

test('RangePicker reports the range a click chose in minutes', async () => {
  const onChange = vi.fn()
  render(<RangePicker minutes={60} onChange={onChange} />)

  await userEvent.click(screen.getByRole('button', { name: '1 week' }))

  expect(onChange).toHaveBeenCalledWith(10_080)
})
