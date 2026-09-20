import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { AdminAuthError } from '@/lib/adminApi'
import { useAuthStore } from '@/stores/authStore'

// The members call is ~15s (Wizarr fan-out), so never refetch it just for
// window focus and don't retry — failures here are auth or config, not blips.
// gcTime must cover the persister's maxAge or restored data gets collected.
export const CACHE_MS = 30 * 60 * 1000

/**
 * End the session on a 401 from the bridge.
 *
 * Every 401 means the same thing wherever it lands, so the caches own the
 * reaction and the gate takes the page back; no query and no mutation repeats
 * the guard.
 */
const onAuthError = (cause: unknown): void => {
  if (cause instanceof AdminAuthError) {
    void useAuthStore.getState().signOut()
  }
}

/** The app's one query client, and the one the tests render against. */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    queryCache: new QueryCache({ onError: onAuthError }),
    mutationCache: new MutationCache({ onError: onAuthError }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        gcTime: CACHE_MS,
      },
    },
  })
