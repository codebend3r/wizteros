import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
  test,
  type Mock,
} from 'bun:test'

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test }

// Records globals replaced via stubGlobal so they can be restored between tests.
const stubbedGlobals = new Map<string, { existed: boolean; value: unknown }>()

const stubGlobal = (name: string, value: unknown): void => {
  if (!stubbedGlobals.has(name)) {
    stubbedGlobals.set(name, {
      existed: Reflect.has(globalThis, name),
      value: Reflect.get(globalThis, name),
    })
  }
  Reflect.set(globalThis, name, value)
}

const restoreGlobals = (): void => {
  stubbedGlobals.forEach(({ existed, value }, name) => {
    if (existed) {
      Reflect.set(globalThis, name, value)
    } else {
      Reflect.deleteProperty(globalThis, name)
    }
  })
  stubbedGlobals.clear()
}

// vitest's vi.mocked is a typing bridge: at runtime the value is already a bun
// mock (installed via mock.module); narrow to the mock type with a type guard.
const isMock = <F extends (...args: never[]) => unknown>(fn: F): fn is F & Mock<F> => 'mock' in fn

const mocked = <F extends (...args: never[]) => unknown>(fn: F): F & Mock<F> => {
  if (!isMock(fn)) throw new Error('vi.mocked(): value is not a bun mock')
  return fn
}

// A minimal vitest `vi` surface mapped onto bun:test primitives.
export const vi = {
  fn: mock,
  spyOn,
  mock: mock.module,
  mocked,
  stubGlobal,
  restoreAllMocks: (): void => {
    // restoreAllMocks restores spies; clearAllMocks also zeroes the call
    // history that mock.module mocks retain across tests (vitest parity).
    jest.restoreAllMocks()
    jest.clearAllMocks()
    restoreGlobals()
  },
}

// Safety net: restore any stubbed globals even if a suite forgets to.
afterEach(restoreGlobals)
