import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { defaultShouldDehydrateQuery } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/doto'
import '@fontsource-variable/nunito-sans'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/lily-script-one'
import { AppRoutes } from '@/AppRoutes'
import { CACHE_MS, createQueryClient } from '@/lib/queryClient'
import { isLiveQueryKey } from '@/lib/queryPersistence'
import '@/styles/globals.scss'

const queryClient = createQueryClient()

// React Query's cache is in-memory and dies with the page, so a refresh
// would refetch the ~15s members call. Persist it to sessionStorage — the
// same lifetime as the admin gate's stored password.
const persister = createSyncStoragePersister({ storage: window.sessionStorage })

const rootElement = document.getElementById('root')

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: CACHE_MS,
          // the live fleet queries are excluded, never restored from storage:
          // a half-hour-old fleet painted as the present is the one thing that
          // page must never do
          dehydrateOptions: {
            shouldDehydrateQuery: (query) =>
              defaultShouldDehydrateQuery(query) && !isLiveQueryKey(query.queryKey),
          },
        }}
      >
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </PersistQueryClientProvider>
    </StrictMode>,
  )
}
