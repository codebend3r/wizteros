import { type Mock, vi } from 'vitest'
import type {
  Bridge,
  Mailer,
  PlexApi,
  Settings,
  StripeApi,
  StripeSubscription,
  WizarrApi,
} from '@/types.js'

// Stand-ins for the four services, the MagicMock clients the Python suites
// built. Every method is a vi.fn with a harmless default answer (an empty
// list, no email, nothing sent), so a test sets only what it is about and
// asserts on the calls, as `client.x.return_value = ...` and
// `assert_called_once_with` did.

type Mocked<T> = {
  readonly [K in keyof T]: T[K] extends (...args: never[]) => unknown ? Mock<T[K]> : T[K]
}

export type FakeWizarr = Mocked<WizarrApi>
export type FakeStripe = Mocked<StripeApi>
export type FakePlex = Mocked<PlexApi>
export type FakeMailer = Mocked<Mailer>

export type FakeBridge = Readonly<{
  dbPath: string
  wizarr: FakeWizarr
  stripe: FakeStripe
  plex: FakePlex
  mailer: FakeMailer
  settings: Settings
}>

export const fakeWizarr = (): FakeWizarr => ({
  listLibraries: vi.fn<WizarrApi['listLibraries']>(async () => []),
  createInvite: vi.fn<WizarrApi['createInvite']>(async () => ({
    code: 'code',
    url: 'http://wizarr.test/j/code',
  })),
  listInvitations: vi.fn<WizarrApi['listInvitations']>(async () => []),
  deleteInvitation: vi.fn<WizarrApi['deleteInvitation']>(async () => {}),
  listUsers: vi.fn<WizarrApi['listUsers']>(async () => []),
  findUsersByEmail: vi.fn<WizarrApi['findUsersByEmail']>(async () => []),
  findUserIdsByEmail: vi.fn<WizarrApi['findUserIdsByEmail']>(async () => []),
  findUserIdsByInvite: vi.fn<WizarrApi['findUserIdsByInvite']>(async () => []),
  setExpiry: vi.fn<WizarrApi['setExpiry']>(async () => {}),
  disableUser: vi.fn<WizarrApi['disableUser']>(async () => {}),
})

/** A subscription with the fields the bridge reads; override what a test is about. */
export const subscription = (fields: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  cancel_at: null,
  ...fields,
})

export const fakeStripe = (): FakeStripe => ({
  customerEmail: vi.fn<StripeApi['customerEmail']>(async () => null),
  searchCustomerId: vi.fn<StripeApi['searchCustomerId']>(async () => null),
  customerIdsForEmail: vi.fn<StripeApi['customerIdsForEmail']>(async () => []),
  subscriptionsFor: vi.fn<StripeApi['subscriptionsFor']>(async () => []),
  cancelAtPeriodEnd: vi.fn<StripeApi['cancelAtPeriodEnd']>(async (id) =>
    subscription({ id, cancel_at_period_end: true }),
  ),
  allSubscriptions: vi.fn<StripeApi['allSubscriptions']>(async () => []),
})

/** No token and no plex.tv by default: the library list is trusted as given. */
export const fakePlex = (): FakePlex => ({
  hasToken: vi.fn<PlexApi['hasToken']>(() => false),
  liveSectionsOrNone: vi.fn<PlexApi['liveSectionsOrNone']>(async () => null),
  sharedAccessAll: vi.fn<PlexApi['sharedAccessAll']>(async () => ({})),
  sharedAccessForEmail: vi.fn<PlexApi['sharedAccessForEmail']>(async () => ({})),
})

/** Nothing reaches an SMTP host. */
export const fakeMailer = (): FakeMailer => ({
  sendInvite: vi.fn<Mailer['sendInvite']>(async () => {}),
  sendAlert: vi.fn<Mailer['sendAlert']>(async () => {}),
})

/** The environment the Python suites set before importing the bridge. */
export const TEST_SETTINGS: Settings = {
  publicInviteBase: 'http://inv.test',
  accessDuration: '35',
  inviteDays: 14,
  baselineExpiresDays: 2,
}

/**
 * A bridge over `dbPath` with every service faked. The store is not created
 * here; a test that reads or writes it calls initDb first, as the Python
 * fixtures called store.init_db.
 */
export const fakeBridge = ({
  dbPath,
  settings = TEST_SETTINGS,
}: {
  dbPath: string
  settings?: Settings
}): FakeBridge => ({
  dbPath,
  wizarr: fakeWizarr(),
  stripe: fakeStripe(),
  plex: fakePlex(),
  mailer: fakeMailer(),
  settings,
})

/** The fake as the `Bridge` the code under test takes. */
export const asBridge = (fake: FakeBridge): Bridge => fake
