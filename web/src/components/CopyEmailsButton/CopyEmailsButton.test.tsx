import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import CopyEmailsButton from '@/components/CopyEmailsButton/CopyEmailsButton'

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('copies a deduped, comma-separated list and confirms', async () => {
  render(<CopyEmailsButton emails={['a@x.com', 'A@x.com', ' b@x.com ', '']} />)
  fireEvent.click(screen.getByRole('button'))
  expect(writeText).toHaveBeenCalledWith('a@x.com, b@x.com')
  expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
})

test('is disabled when there are no emails', () => {
  render(<CopyEmailsButton emails={['', '  ']} />)
  expect(screen.getByRole('button')).toBeDisabled()
})
