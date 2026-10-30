import { defineConfig } from 'vitest/config'

// Own config, like scripts/dev/fake-mail's: only the simulator's daemon, never the repo's suite. Each
// simulator gets its own vite cache directory (SIM_VITE_CACHE, inside its temp dir), so parallel
// simulators and the other agents' runs share nothing.
export default defineConfig({
  root: new URL('../../..', import.meta.url).pathname,
  test: {
    include: ['scripts/dev/persona-sim/**/*.run.ts'],
    pool: 'forks',
    testTimeout: 7 * 24 * 3_600_000,
    hookTimeout: 60_000,
    cache: false,
    reporters: ['default'],
  },
  cacheDir: process.env.SIM_VITE_CACHE ?? '/tmp/parcels-personasim-vite-cache',
})
