import { render, screen } from '@testing-library/react'
import Support from './Support'

const items = [
  { title: 'Server hardware', detail: 'Always-on machines.' },
  { title: 'Storage & bandwidth', detail: 'Disks and network capacity.' },
]

test('renders one heading per support item', () => {
  render(<Support items={items} />)
  expect(screen.getByRole('heading', { name: 'Server hardware' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Storage & bandwidth' })).toBeInTheDocument()
  expect(screen.getByText('Disks and network capacity.')).toBeInTheDocument()
})
