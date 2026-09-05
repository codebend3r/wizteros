import { afterEach } from 'bun:test'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useAuthStore } from '@/stores/authStore'
import { useTierStore } from '@/stores/tierStore'

const initialAuthState = useAuthStore.getInitialState()
const initialTierState = useTierStore.getInitialState()

// vitest globals auto-unmounted between tests; Bun test does not, so clean up
// the rendered tree after each test to keep the DOM isolated.
//
// The auth store reset lives here, after cleanup, rather than in each suite:
// Bun runs a file's own afterEach ahead of this preload hook, so a per-file
// reset lands while the tree is still mounted and React logs the update as
// happening outside act(...). Unmounting first leaves nothing subscribed.
// Recharts measures label text through a hidden span it appends to the body
// and never removes, so it outlives cleanup() holding whatever it measured
// last. A tick label such as "0%" left in the body is then found by the next
// test's queryByText, and which test that is depends on file order. Recharts
// looks the span up by id on every measurement, so removing it is safe.
const RECHARTS_MEASUREMENT_SPAN_ID = 'recharts_measurement_span'

afterEach(() => {
  cleanup()
  document.getElementById(RECHARTS_MEASUREMENT_SPAN_ID)?.remove()
  useAuthStore.setState(initialAuthState, true)
  useTierStore.setState(initialTierState, true)
})
