import { defaultShouldDehydrateQuery, type Query, type QueryClient } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import type { Persister } from '@tanstack/react-query-persist-client'
import { useAuthStore } from '@/stores/authStore'

// Only the ~15s members lookup opts in. New queries, including fleet-metric,
// stay in memory unless deliberately added here.
export const shouldPersistQuery = (query: Query): boolean =>
  defaultShouldDehydrateQuery(query) && query.queryKey[0] === 'members'

// Invalidate blobs written before the strict Member guard and opt-in policy.
export const QUERY_CACHE_BUSTER = 'members-v2'

/** Tie the memory and persisted caches to the signed-in session. */
export const createSessionCache = ({
  queryClient,
  storage,
}: {
  queryClient: QueryClient
  storage: Storage
}): { persister: Persister; unsubscribe: () => void } => {
  let generation = 0
  const createPersister = () => {
    const current = generation
    return createSyncStoragePersister({
      storage: {
        getItem: (key) => storage.getItem(key),
        removeItem: (key) => storage.removeItem(key),
        // The underlying persister throttles writes. A pending pre-sign-out
        // write must not resurrect member data, even after a quick sign-in.
        setItem: (key, value) => {
          if (current === generation && useAuthStore.getState().status === 'signed-in') {
            storage.setItem(key, value)
          }
        },
      },
    })
  }
  let current = createPersister()
  const persister: Persister = {
    persistClient: (client) => {
      if (useAuthStore.getState().status === 'signed-in') {
        return current.persistClient(client)
      }
    },
    restoreClient: () => current.restoreClient(),
    removeClient: () => {
      generation += 1
      current.removeClient()
      current = createPersister()
    },
  }
  const clear = () => {
    queryClient.clear()
    void persister.removeClient()
  }
  const unsubscribe = useAuthStore.subscribe((state, previous) => {
    if (
      state.status === 'signed-out' ||
      (previous.status === 'signed-in' && state.email !== previous.email)
    ) {
      clear()
    }
  })
  if (useAuthStore.getState().status === 'signed-out') clear()
  return { persister, unsubscribe }
}
