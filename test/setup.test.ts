import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// setup.sh and update.sh are checked by a shell test (they are shell, and it needs git and stat);
// this runs it under the suite so it cannot rot. It works entirely in a temp directory: it never
// touches the real config.json, never calls launchctl, and exercises update.sh against a throwaway
// clone whose origin is this directory, so this repository's branch and remote are left alone.
test('setup.sh and update.sh behave (test/setup.test.sh)', () => {
  const script = fileURLToPath(new URL('./setup.test.sh', import.meta.url))
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 120_000 })
  expect(r.stdout.split('\n').filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(r.status).toBe(0)
})
