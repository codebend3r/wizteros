import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// Declaration merging requires `interface`; this teaches bun:test's expect
// about the @testing-library/jest-dom matchers (toBeInTheDocument, etc.).
declare module 'bun:test' {
  interface Matchers<T> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers<unknown, unknown> {}
}
