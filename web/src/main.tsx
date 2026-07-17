import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource/silkscreen'
import AppRoutes from '@/AppRoutes'
import '@/styles/globals.scss'

// The members call is ~15s (Wizarr fan-out), so never refetch it just for
// window focus and don't retry — failures here are auth or config, not blips.
// gcTime must cover the persister's maxAge or restored data gets collected.
const CACHE_MINUTES = 30

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      gcTime: CACHE_MINUTES * 60 * 1000,
    },
  },
})

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
        persistOptions={{ persister, maxAge: CACHE_MINUTES * 60 * 1000 }}
      >
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </PersistQueryClientProvider>
    </StrictMode>,
  )
}
