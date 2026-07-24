import { afterEach } from 'bun:test'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

// vitest globals auto-unmounted between tests; Bun test does not, so clean up
// the rendered tree after each test to keep the DOM isolated.
afterEach(() => {
  cleanup()
})
