import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the brand name', () => {
  render(<App />)
  expect(screen.getByText('Westeroz')).toBeInTheDocument()
})
