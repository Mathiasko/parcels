import { describe, expect, test } from 'vitest'
import { restartDelay, Supervisor, type Child, type SupervisorState } from '../../app/supervise.js'
import type { ToMain } from '../../src/core/app-ipc.js'

test('restartDelay doubles from one second and stops at a minute', () => {
  expect(restartDelay(1)).toBe(1000)
  expect(restartDelay(2)).toBe(2000)
  expect(restartDelay(3)).toBe(4000)
  expect(restartDelay(7)).toBe(60_000)
  expect(restartDelay(1000)).toBe(60_000)
  // Zero and nonsense are treated as the first crash, never as no delay at all.
  expect(restartDelay(0)).toBe(1000)
  expect(restartDelay(Number.NaN)).toBe(1000)
})

/** A child the test drives: it records what it was sent and whether it was killed, and exits on demand. */
class FakeChild implements Child {
  sent: unknown[] = []
  killed = false
  private exitFns: ((code: number) => void)[] = []
  private messageFns: ((m: unknown) => void)[] = []
  constructor(readonly env: Record<string, string>) {}
  on(e: 'exit', f: (code: number) => void): void
  on(e: 'message', f: (m: unknown) => void): void
  on(e: 'exit' | 'message', f: ((code: number) => void) | ((m: unknown) => void)): void {
    if (e === 'exit') this.exitFns.push(f as (code: number) => void)
    else this.messageFns.push(f as (m: unknown) => void)
  }
  postMessage(m: unknown): void { this.sent.push(m) }
  kill(): void { this.killed = true }
  exit(code: number): void { for (const f of this.exitFns) f(code) }
  message(m: unknown): void { for (const f of this.messageFns) f(m) }
}

interface FakeTimer { fn: () => void; ms: number; at: number; cleared: boolean; fired: boolean }

/** A Supervisor on a fake clock: `advance` moves time and fires every timer that came due. */
function harness() {
  const clock = { now: 1_000_000 }
  const timers: FakeTimer[] = []
  const children: FakeChild[] = []
  const states: SupervisorState[] = []
  const messages: ToMain[] = []
  const invalid: unknown[] = []
  const sup = new Supervisor({
    fork: env => { const c = new FakeChild(env); children.push(c); return c },
    env: { PARCELS_HOST: 'app', PARCELS_CONFIG: '/h/config.json' },
    onMessage: m => { messages.push(m) },
    onState: s => { states.push(s) },
    onInvalid: m => { invalid.push(m) },
    setTimer: (fn, ms) => {
      const t: FakeTimer = { fn, ms, at: clock.now + ms, cleared: false, fired: false }
      timers.push(t)
      return { clear: () => { t.cleared = true } }
    },
    now: () => clock.now,
  })
  const advance = (ms: number) => {
    clock.now += ms
    for (const t of timers) {
      if (!t.cleared && !t.fired && t.at <= clock.now) { t.fired = true; t.fn() }
    }
  }
  const pending = () => timers.filter(t => !t.cleared && !t.fired)
  return { sup, clock, timers, pending, children, states, messages, invalid, advance }
}

describe('Supervisor', () => {
  test('start forks once with the environment plus PARCELS_RESTARTS=0, and says running', () => {
    const h = harness()
    h.sup.start()
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.env).toEqual({ PARCELS_HOST: 'app', PARCELS_CONFIG: '/h/config.json', PARCELS_RESTARTS: '0' })
    expect(h.states).toEqual(['running'])
    expect(h.sup.restarts).toBe(0)
    // A second start while the child runs does not fork a second server onto the same port.
    h.sup.start()
    expect(h.children).toHaveLength(1)
  })

  test('exit 1 says restarting, and forks again after one second with PARCELS_RESTARTS=1', () => {
    const h = harness()
    h.sup.start()
    h.children[0]!.exit(1)
    expect(h.states).toEqual(['running', 'restarting'])
    h.advance(999)
    expect(h.children).toHaveLength(1)
    h.advance(1)
    expect(h.children).toHaveLength(2)
    expect(h.children[1]!.env.PARCELS_RESTARTS).toBe('1')
    expect(h.sup.restarts).toBe(1)
    expect(h.states).toEqual(['running', 'restarting', 'running'])
  })

  test('three quick crashes wait 1, 2 and 4 seconds', () => {
    const h = harness()
    h.sup.start()
    const delays: number[] = []
    for (let i = 0; i < 3; i++) {
      h.advance(5_000)
      h.children.at(-1)!.exit(1)
      const [t] = h.pending()
      delays.push(t!.ms)
      h.advance(t!.ms)
    }
    expect(delays).toEqual([1000, 2000, 4000])
    expect(h.children).toHaveLength(4)
    expect(h.children[3]!.env.PARCELS_RESTARTS).toBe('3')
  })

  test('a crash after ten minutes up waits one second again', () => {
    const h = harness()
    h.sup.start()
    for (let i = 0; i < 3; i++) {
      h.children.at(-1)!.exit(1)
      h.advance(h.pending()[0]!.ms)
    }
    h.advance(10 * 60_000)
    h.children.at(-1)!.exit(1)
    expect(h.pending()[0]!.ms).toBe(1000)
    // The count the dashboard shows is every restart, not only the consecutive ones.
    h.advance(1000)
    expect(h.sup.restarts).toBe(4)
  })

  test('exit 3 says port-busy and never forks again', () => {
    const h = harness()
    h.sup.start()
    h.children[0]!.exit(3)
    expect(h.states).toEqual(['running', 'port-busy'])
    expect(h.pending()).toHaveLength(0)
    h.advance(10 * 60_000)
    expect(h.children).toHaveLength(1)
  })

  test('stop sends shutdown, resolves when the child exits, says stopped, and never restarts', async () => {
    const h = harness()
    h.sup.start()
    const stopped = h.sup.stop()
    expect(h.children[0]!.sent).toEqual([{ type: 'shutdown' }])
    h.children[0]!.exit(0)
    await stopped
    expect(h.children[0]!.killed).toBe(false)
    expect(h.states.at(-1)).toBe('stopped')
    h.advance(60 * 60_000)
    expect(h.children).toHaveLength(1)
  })

  test('stop kills a child that does not exit within five seconds, and no restart follows', async () => {
    const h = harness()
    h.sup.start()
    let done = false
    const stopped = h.sup.stop().then(() => { done = true })
    h.advance(4_999)
    expect(h.children[0]!.killed).toBe(false)
    h.advance(1)
    expect(h.children[0]!.killed).toBe(true)
    await stopped
    expect(done).toBe(true)
    // The kill's own exit (a signal, so not 0 and not 3) must not be read as a crash.
    h.children[0]!.exit(15)
    h.advance(60 * 60_000)
    expect(h.children).toHaveLength(1)
    expect(h.states.at(-1)).toBe('stopped')
    expect(h.states).not.toContain('restarting')
  })

  test('stop while waiting to restart cancels the restart', async () => {
    const h = harness()
    h.sup.start()
    h.children[0]!.exit(1)
    await h.sup.stop()
    h.advance(60_000)
    expect(h.children).toHaveLength(1)
    expect(h.states.at(-1)).toBe('stopped')
  })

  test('send reaches the running child, and is dropped while none runs', () => {
    const h = harness()
    h.sup.send({ type: 'refresh' })
    h.sup.start()
    h.sup.send({ type: 'wake' })
    expect(h.children[0]!.sent).toEqual([{ type: 'wake' }])
    h.children[0]!.exit(1)
    expect(() => h.sup.send({ type: 'refresh' })).not.toThrow()
  })

  test('messages are passed on only when they have a known shape; the rest go to onInvalid', () => {
    const h = harness()
    h.sup.start()
    h.children[0]!.message({ type: 'ready-count', n: 2 })
    h.children[0]!.message({ type: 'ready-count', n: 'two' })
    h.children[0]!.message({ type: 'open-calculator' })
    expect(h.messages).toEqual([{ type: 'ready-count', n: 2 }])
    expect(h.invalid).toEqual([{ type: 'ready-count', n: 'two' }, { type: 'open-calculator' }])
  })

  test('a fork that throws counts as a crash and is retried after the backoff', () => {
    const h = harness()
    let fail = true
    const sup = new Supervisor({
      fork: env => {
        if (fail) { fail = false; throw new Error('spawn failed') }
        const c = new FakeChild(env); h.children.push(c); return c
      },
      env: {},
      onMessage: () => {},
      onState: s => { h.states.push(s) },
      setTimer: (fn, ms) => {
        const t = { fn, ms, at: h.clock.now + ms, cleared: false, fired: false }
        h.timers.push(t)
        return { clear: () => { t.cleared = true } }
      },
      now: () => h.clock.now,
    })
    sup.start()
    expect(h.states).toEqual(['restarting'])
    h.advance(1000)
    expect(h.children).toHaveLength(1)
    expect(h.states).toEqual(['restarting', 'running'])
  })
})
