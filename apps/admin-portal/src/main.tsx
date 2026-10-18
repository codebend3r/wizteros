import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/doto'
import '@fontsource-variable/nunito-sans'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/lily-script-one'
import { AppRoutes } from '@/AppRoutes'
import { CACHE_MS, createQueryClient } from '@/lib/queryClient'
import { createSessionCache, QUERY_CACHE_BUSTER, shouldPersistQuery } from '@/lib/queryPersistence'
import '@/styles/globals.scss'

const queryClient = createQueryClient()

// Persist the slow members lookup across reloads, never across sign-out.
const { persister } = createSessionCache({ queryClient, storage: window.sessionStorage })

const rootElement = document.getElementById('root')

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: CACHE_MS,
          buster: QUERY_CACHE_BUSTER,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </PersistQueryClientProvider>
    </StrictMode>,
  )
}
