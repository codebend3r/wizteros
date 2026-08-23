import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import { UpdateRateSlider } from '@/pages/Fleet/UpdateRateSlider'
import { DEFAULT_UPDATE_INTERVAL_MS, UPDATE_INTERVAL_STOPS_MS } from '@/stores/fleetPrefsStore'

test('the default interval is one second and sits among the stops', () => {
  expect(DEFAULT_UPDATE_INTERVAL_MS).toBe(1000)
  expect(UPDATE_INTERVAL_STOPS_MS).toContain(DEFAULT_UPDATE_INTERVAL_MS)
})

test('UpdateRateSlider is a labelled slider reading out the current interval', () => {
  render(<UpdateRateSlider intervalMs={1000} onChange={() => {}} />)

  const slider = screen.getByLabelText('Update every')
  expect(slider).toHaveAttribute('aria-valuetext', '1 s')
  expect(screen.getByText('1 s')).toBeInTheDocument()
})

test('UpdateRateSlider reads sub-second stops in milliseconds', () => {
  render(<UpdateRateSlider intervalMs={100} onChange={() => {}} />)

  expect(screen.getByLabelText('Update every')).toHaveAttribute('aria-valuetext', '100 ms')
  expect(screen.getByText('100 ms')).toBeInTheDocument()
})

test('UpdateRateSlider reports the stop in milliseconds, not the slider index', () => {
  const chosen: number[] = []
  render(<UpdateRateSlider intervalMs={1000} onChange={(ms) => chosen.push(ms)} />)

  const slider = screen.getByLabelText('Update every')
  fireEvent.change(slider, { target: { value: '0' } })
  fireEvent.change(slider, { target: { value: '5' } })

  expect(chosen).toEqual([100, 10_000])
})
