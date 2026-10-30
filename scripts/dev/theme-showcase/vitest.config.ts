import { defineConfig } from 'vitest/config'

// Own config, like scripts/dev/fake-mail's: the repo's suite (test/**/*.test.ts) never picks the showcase
// up, and this config runs nothing else.
export default defineConfig({
  root: new URL('../../..', import.meta.url).pathname,
  test: {
    include: ['scripts/dev/theme-showcase/**/*.run.ts'],
    pool: 'forks',
    testTimeout: 900_000,
    cache: false,
    reporters: ['default'],
  },
  cacheDir: '/tmp/parcels-theme-showcase-vite-cache',
})
