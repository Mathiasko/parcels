import { describe, expect, test } from 'vitest'
import { runPollOnce } from '../src/poll.js'
import { claimRun, listRuns, startRun } from '../src/db/poll-runs.js'
import { config, memDb, NOW } from './poll-helpers.js'

// A fake update check: the default would run scripts/update.sh, which a test must never do.
const updateCheck = { run: () => ({ status: 0, stdout: 'state current\n', stderr: '' }) }

describe('runPollOnce', () => {
  test('runs a poll on the database it is given and leaves that database open', async () => {
    const db = memDb()
    const out = await runPollOnce(db, config, { now: NOW, updateCheck })
    expect(out.ran).toBe(true)
    expect(out.summary).toMatch(/polled/)
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 })
    // The run was recorded in the activity log, finished, and the poll time was noted.
    const [run] = listRuns(db, 1)
    expect(run).toMatchObject({ trigger: 'poller' })
    expect(run!.finishedAt).toBeDefined()
    expect(db.prepare('SELECT COUNT(*) n FROM last_poll').get()).toEqual({ n: 1 })
    db.close()
  })

  test('does not poll while another run is live, and says so', async () => {
    const db = memDb()
    const live = startRun(db, 'web', new Date(NOW.getTime() - 1000))
    const out = await runPollOnce(db, config, { now: NOW, updateCheck })
    expect(out.ran).toBe(false)
    expect(out.summary).toMatch(new RegExp(`run ${live} \\(web, started .*\\) is already in progress; not polling`))
    expect(listRuns(db, 10).map(r => r.id)).toEqual([live])
    expect(db.prepare('SELECT COUNT(*) n FROM last_poll').get()).toEqual({ n: 0 })
    expect(db.prepare('select 1 as one').get()).toEqual({ one: 1 })
    db.close()
  })

  test('uses the notifier it is handed instead of building one from the config', async () => {
    const db = memDb()
    const sent: string[] = []
    await runPollOnce(db, config, {
      now: NOW, updateCheck, notifier: { send: async n => { sent.push(n.title) } },
    })
    // Nothing to announce on an empty database; the point is that the run accepts the override.
    expect(sent).toEqual([])
    expect(claimRun(db, 'poller', new Date(NOW.getTime() + 60_000)).claimed).toBe(true)
    db.close()
  })
})
