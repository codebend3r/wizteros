import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from '@/test/vi'
import { HeroLogo } from '@/components/Hero/HeroLogo'

test('renders the mascot image', () => {
  render(<HeroLogo />)
  expect(screen.getByAltText('Westeroz mascot')).toBeInTheDocument()
})

test('plays the video while hovering and reverts on leave', () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)

  render(<HeroLogo />)
  const logo = screen.getByRole('figure')

  fireEvent.mouseEnter(logo)
  expect(play).toHaveBeenCalledTimes(1)

  fireEvent.mouseLeave(logo)
  expect(pause).toHaveBeenCalledTimes(1)

  play.mockRestore()
  pause.mockRestore()
})
