import { afterEach, expect, test, vi } from '@/test/vi'
import { dehydrate, QueryClient } from '@tanstack/react-query'
import { persistQueryClientRestore } from '@tanstack/react-query-persist-client'
import { createSessionCache, QUERY_CACHE_BUSTER, shouldPersistQuery } from '@/lib/queryPersistence'
import { createQueryClient } from '@/lib/queryClient'
import { AdminAuthError } from '@/lib/adminApi'
import { fetchFleet, fetchIncidents, fetchMetricHistory } from '@/lib/fleetApi'
import { useAuthStore } from '@/stores/authStore'

const original = useAuthStore.getState()
afterEach(() => {
  useAuthStore.setState(original)
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('only successful members queries opt in to persistence', () => {
  const client = new QueryClient()
  ;[
    ['members'],
    ['fleet'],
    ['fleet-incidents', 24],
    ['fleet-metric', 'cpu', 60],
    ['plays-sync'],
    ['new-query'],
  ].map((key) => client.setQueryData(key, []))
  client.getQueryCache().build(client, { queryKey: ['not-loaded'] })
  expect(
    dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map(
      (query) => query.queryKey,
    ),
  ).toEqual([['members']])
  client.clear()
})

test('the opted-in members lookup survives a reload during the same session', async () => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  const queryClient = createQueryClient()
  const { persister, unsubscribe } = createSessionCache({ queryClient, storage: sessionStorage })
  try {
    queryClient.setQueryData(['members'], ['member'])
    queryClient.setQueryData(['fleet-metric', 'cpu', 60], ['live'])
    await persister.persistClient({
      timestamp: Date.now(),
      buster: QUERY_CACHE_BUSTER,
      clientState: dehydrate(queryClient, { shouldDehydrateQuery: shouldPersistQuery }),
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    queryClient.clear()
    await persistQueryClientRestore({ queryClient, persister, buster: QUERY_CACHE_BUSTER })
    expect(queryClient.getQueryData<string[]>(['members'])).toEqual(['member'])
    expect(queryClient.getQueryData(['fleet-metric', 'cpu', 60])).toBeUndefined()
    await persister.removeClient()
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('sign-out clears both caches and blocks pending writes even after a quick sign-in', async () => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  const queryClient = createQueryClient()
  const { persister, unsubscribe } = createSessionCache({ queryClient, storage: sessionStorage })
  try {
    queryClient.setQueryData(['members'], [{ email: 'private@x.com' }])
    await persister.persistClient({
      timestamp: Date.now(),
      buster: QUERY_CACHE_BUSTER,
      clientState: dehydrate(queryClient),
    })
    await useAuthStore.getState().signOut()
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(sessionStorage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull()
    useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(sessionStorage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull()
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('an external signed-out event clears cached member data too', () => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  const queryClient = createQueryClient()
  const { unsubscribe } = createSessionCache({ queryClient, storage: sessionStorage })
  try {
    queryClient.setQueryData(['members'], ['private'])
    sessionStorage.setItem('REACT_QUERY_OFFLINE_CACHE', 'private')
    useAuthStore.setState({ status: 'signed-out', email: null })
    expect(queryClient.getQueryData(['members'])).toBeUndefined()
    expect(sessionStorage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull()
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('a mutation 401 also signs out and removes member data', async () => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  const queryClient = createQueryClient()
  const { unsubscribe } = createSessionCache({ queryClient, storage: sessionStorage })
  try {
    queryClient.setQueryData(['members'], ['private'])
    sessionStorage.setItem('REACT_QUERY_OFFLINE_CACHE', 'private')
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        throw new AdminAuthError('Not signed in')
      },
    })
    await expect(mutation.execute(undefined)).rejects.toBeInstanceOf(AdminAuthError)
    expect(useAuthStore.getState().status).toBe('signed-out')
    expect(queryClient.getQueryData(['members'])).toBeUndefined()
    expect(sessionStorage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull()
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test('old persisted contracts are discarded instead of bypassing the new guards', async () => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  const queryClient = createQueryClient()
  const { persister, unsubscribe } = createSessionCache({ queryClient, storage: sessionStorage })
  sessionStorage.setItem(
    'REACT_QUERY_OFFLINE_CACHE',
    JSON.stringify({
      timestamp: Date.now(),
      buster: '',
      clientState: { mutations: [], queries: [] },
    }),
  )
  try {
    await persistQueryClientRestore({ queryClient, persister, buster: QUERY_CACHE_BUSTER })
    expect(sessionStorage.getItem('REACT_QUERY_OFFLINE_CACHE')).toBeNull()
  } finally {
    unsubscribe()
    queryClient.clear()
  }
})

test.each([
  () => fetchFleet(),
  () => fetchIncidents({ hours: 24 }),
  () => fetchMetricHistory({ kind: 'cpu', minutes: 60 }),
])('a monitor 401 follows the shared query sign-out path', async (queryFn) => {
  useAuthStore.setState({ status: 'signed-in', email: 'admin@x.com' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
  const client = createQueryClient()
  try {
    await expect(
      client.fetchQuery<unknown>({ queryKey: ['auth-test'], queryFn }),
    ).rejects.toBeInstanceOf(AdminAuthError)
    expect(useAuthStore.getState().status).toBe('signed-out')
  } finally {
    client.clear()
  }
})
