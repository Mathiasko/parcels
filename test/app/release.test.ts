import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// release.sh publishes for real, so the shell test runs it from a throwaway copy with git, gh and
// security stubbed and the build replaced: it checks the refusals, the prompt, and what a stubbed
// publish would call.
test('release.sh refuses what it must and publishes only when told to (test/app/release.test.sh)', () => {
  const script = fileURLToPath(new URL('./release.test.sh', import.meta.url))
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 60_000 })
  expect(r.stdout.split('\n').filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(r.status).toBe(0)
})
