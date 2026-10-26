import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The launchd plists and installer are checked by a shell test (it needs macOS plutil); this runs
// it under the suite so it cannot rot. It renders into a temp dir and never calls launchctl.
test('install-agents renders valid, correct plists (test/install-agents.test.sh)', () => {
  const script = fileURLToPath(new URL('./install-agents.test.sh', import.meta.url))
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 30_000 })
  expect(r.stdout.split('\n').filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(r.status).toBe(0)
})
