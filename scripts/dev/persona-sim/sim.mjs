// The `sim` command (see README.md here). `start` launches the simulator daemon (daemon.run.ts, under
// vitest) in the background and waits for it; every other command is sent to it over its loopback control
// port. Several simulators may run at once, one per persona: commands pick the only running one, or the
// one named with --as <persona>.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const REG = join(tmpdir(), 'parcels-persona-sim')
const PERSONAS = readdirSync(join(HERE, 'scenarios')).filter(f => existsSync(join(HERE, 'scenarios', f, 'scenario.json')))

const USAGE = `sim - the parcels persona simulator

  sim start <persona> [--dir D]     start your simulated Mac (day 0, the evening you install Parcels)
  sim day [--until HH:MM]           live through the rest of today, or the next day, and print the day digest
  sim status                        date, time, menu-bar count, dashboard address
  sim text <page>                   what a page shows, with its links and forms
                                    pages: /  /settings  /parcel/3 ...  app:first-run  readme  readme:<section>
  sim post <action> name=value ...  submit a form (click a button), print where you end up
  sim shot <page> [--width 1280|390] [--dark] [--out file.png]   screenshot a page, print the file path
  sim mail [n]                      your Gmail inbox, or mail number n in full
  sim collect <code-or-number>      go to the pickup point and collect a parcel with that code / number
  sim stop [--keep]                 shut down and delete the simulated Mac (--keep keeps its folder)

  With several simulators running, add --as <persona> to any command.
  Personas: ${PERSONAS.join(', ')}`

const argv = process.argv.slice(2)
let as
const asIdx = argv.indexOf('--as')
if (asIdx >= 0) { as = argv[asIdx + 1]; argv.splice(asIdx, 2) }
const [cmd, ...args] = argv

const running = () => (existsSync(REG) ? readdirSync(REG).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(REG, f), 'utf8'))) : [])
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function pick() {
  const all = running().filter(r => alive(r.pid))
  if (as) {
    const r = all.find(x => x.persona === as)
    if (!r) fail(`No simulator for "${as}" is running. Start one: sim start ${as}`)
    return r
  }
  if (all.length === 0) fail('No simulator is running. Start one: sim start <persona>')
  if (all.length > 1) fail(`Several simulators are running (${all.map(r => r.persona).join(', ')}): add --as <persona>.`)
  return all[0]
}
function fail(msg) { console.error(msg); process.exit(1) }

function send(reg, command, cmdArgs) {
  const state = JSON.parse(readFileSync(join(reg.dir, 'state.json'), 'utf8'))
  const body = JSON.stringify({ token: state.token, cmd: command, args: cmdArgs })
  return new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port: state.controlPort, method: 'POST', path: '/cmd', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => {
      let out = ''
      r.setEncoding('utf8')
      r.on('data', c => { out += c })
      r.on('end', () => { try { res(JSON.parse(out)) } catch (e) { rej(e) } })
    })
    req.on('error', rej)
    req.end(body)
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function start() {
  const persona = args[0]
  if (!persona || !PERSONAS.includes(persona)) fail(`sim start <persona>; personas: ${PERSONAS.join(', ')}`)
  const existing = running().find(r => r.persona === persona && alive(r.pid))
  if (existing) fail(`A simulator for ${persona} is already running (${existing.dir}). Stop it first: sim stop --as ${persona}`)
  const di = args.indexOf('--dir')
  let dir
  if (di >= 0) {
    dir = resolve(args[di + 1])
    if (existsSync(dir) && readdirSync(dir).length) fail(`--dir ${dir} is not empty`)
    mkdirSync(dir, { recursive: true })
  } else dir = mkdtempSync(join(tmpdir(), `parcels-sim-${persona}-`))
  const node = process.execPath
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  const out = openSync(join(dir, 'daemon.log'), 'a')
  const child = spawn(node, [vitest, 'run', '--config', join(HERE, 'vitest.config.ts'), join(HERE, 'daemon.run.ts')], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
    env: {
      PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TZ: 'Europe/Bratislava', LANG: 'en_US.UTF-8',
      PARCELS_HOST: 'app', PARCELS_APP_VERSION: '0.1.0',
      SIM_PERSONA: persona, SIM_DIR: dir, SIM_VITE_CACHE: join(dir, 'vite-cache'),
    },
  })
  child.unref()
  mkdirSync(REG, { recursive: true })
  const reg = { persona, dir, pid: child.pid }
  writeFileSync(join(REG, `${persona}.json`), JSON.stringify(reg))
  for (let i = 0; i < 240; i++) {
    if (existsSync(join(dir, 'state.json'))) {
      const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
      console.log([
        `Simulator for ${persona} is running.`,
        `Dashboard:  ${st.url}`,
        `State file: ${join(dir, 'state.json')}`,
        `Folder:     ${dir}`,
        '',
        (await send(reg, 'status', [])).out,
        '',
        'It is the evening of day 0: you have just installed Parcels. Start with: sim text app:first-run',
      ].join('\n'))
      return
    }
    if (!alive(child.pid)) break
    await sleep(500)
  }
  unlinkSync(join(REG, `${persona}.json`))
  fail(`The simulator did not start. Log: ${join(dir, 'daemon.log')}\n${readFileSync(join(dir, 'daemon.log'), 'utf8').slice(-3000)}`)
}

async function stop() {
  const reg = pick()
  const keep = args.includes('--keep')
  let out = ''
  try { out = (await send(reg, 'stop', [])).out } catch (e) { out = `(the simulator did not answer: ${e.message})` }
  for (let i = 0; i < 60 && alive(reg.pid); i++) await sleep(250)
  if (alive(reg.pid)) { try { process.kill(-reg.pid, 'SIGTERM') } catch {} ; await sleep(1500) }
  if (alive(reg.pid)) { try { process.kill(-reg.pid, 'SIGKILL') } catch {} }
  try { unlinkSync(join(REG, `${reg.persona}.json`)) } catch {}
  try { if (readdirSync(REG).length === 0) rmSync(REG, { recursive: true }) } catch {}
  if (!keep) rmSync(reg.dir, { recursive: true, force: true })
  console.log(`${out}\n${keep ? `Kept ${reg.dir}` : `Removed ${reg.dir}`}`)
}

if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); process.exit(0) }
if (cmd === 'start') await start()
else if (cmd === 'stop') await stop()
else if (['day', 'status', 'text', 'post', 'shot', 'mail', 'collect', 'selftest'].includes(cmd)) {
  const reg = pick()
  const r = await send(reg, cmd, args).catch(e => fail(`The simulator did not answer (${e.message}). Log: ${join(reg.dir, 'daemon.log')}`))
  console.log(r.out)
  if (!r.ok) process.exit(1)
} else fail(USAGE)
