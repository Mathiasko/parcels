import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// install-hostname.sh needs root to do its job, so the shell test checks only what it can without it:
// chiefly that the port it reads from config.json is the web server's and not imap.port.
test('install-hostname reads the right port (test/install-hostname.test.sh)', () => {
  const script = fileURLToPath(new URL('./install-hostname.test.sh', import.meta.url))
  const r = spawnSync('/bin/bash', [script], { encoding: 'utf8', timeout: 30_000 })
  expect(r.stdout.split('\n').filter(l => l.startsWith('FAIL'))).toEqual([])
  expect(r.status).toBe(0)
})
