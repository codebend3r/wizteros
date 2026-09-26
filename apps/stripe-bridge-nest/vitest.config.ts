import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The `@/` alias from tsconfig.json; `nest build` rewrites it for the
  // compiled output, and this resolves it for the tests.
  resolve: { tsconfigPaths: true },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
