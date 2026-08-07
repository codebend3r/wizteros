import { afterEach } from 'bun:test'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useAuthStore } from '@/stores/authStore'

const initialAuthState = useAuthStore.getInitialState()

// vitest globals auto-unmounted between tests; Bun test does not, so clean up
// the rendered tree after each test to keep the DOM isolated.
//
// The auth store reset lives here, after cleanup, rather than in each suite:
// Bun runs a file's own afterEach ahead of this preload hook, so a per-file
// reset lands while the tree is still mounted and React logs the update as
// happening outside act(...). Unmounting first leaves nothing subscribed.
afterEach(() => {
  cleanup()
  useAuthStore.setState(initialAuthState, true)
})
