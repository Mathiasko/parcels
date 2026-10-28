import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// `scripts/update.sh --check --porcelain` and `scripts/update-run.sh` are shell, and checking them
// needs real git: a clone that is genuinely behind another one, a pull that genuinely moves HEAD, and
// a rollback that genuinely puts it back. This runs that shell test under the suite so it cannot rot.
//
// It works entirely in a temp directory. The only thing it does to this repository is a
// `git clone --bare --no-hardlinks` out of it (read-only); every fetch afterwards is between two
// temp directories, so there is no network, no launchd, no npm, and this checkout's branch, remote
// and working tree are left exactly as they were. `npm ci` and `install-agents.sh` are replaced by
// stubs through the wrapper's two documented seams.
//
// Eight local clones of a 3 MB repository, so a few seconds; the timeout is the same budget the
// spawn is given, as in setup.test.ts, so a slow machine fails for a real reason and not for being busy.
test('update.sh --porcelain and update-run.sh behave (test/update-run.test.sh)', () => {
  const script = fileURLToPath(new URL('./update-run.test.sh', import.meta.url))
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 120_000 })
  expect(r.stdout.split('\n').filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(r.status).toBe(0)
}, 120_000)
