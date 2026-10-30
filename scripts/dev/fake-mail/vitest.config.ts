import { defineConfig } from 'vitest/config'

// Own config so the repo's suite (test/**/*.test.ts) never picks this harness up, and vice versa.
export default defineConfig({
  root: new URL('../../..', import.meta.url).pathname,
  test: {
    include: ['scripts/dev/fake-mail/**/*.run.ts'],
    pool: 'threads',
    testTimeout: 900_000,
    // No cache dir in node_modules/.vite or elsewhere shared with the other agent's runs.
    cache: false,
  },
  cacheDir: '/tmp/parcels-fakemail-vite-cache',
})
