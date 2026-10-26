// `probe`, `poll` and flag handling: the commands the brief lists without dedicated tests.
import { test, expect } from 'vitest'
import { runCli } from '../src/cli.js'
import type { HttpClient } from '../src/core/types.js'
import { register } from '../src/carriers/registry.js'
import { findParcel, insertParcel } from '../src/db/parcels.js'
import { config, memDb, ev, okResult, stubAdapter, bodyHttp } from './poll-helpers.js'

async function cli(db: ReturnType<typeof memDb>, argv: string[], extra: Partial<Parameters<typeof runCli>[1]> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(argv, { db, config, out: s => out.push(s), err: s => err.push(s), ...extra })
  return { code, out, err: err.join('\n') }
}

test('probe prints the carrier response body verbatim and the parsed reading separately', async () => {
  const body = '{"results":[{"number":"RA123456785SK","status":"ok","events":[]}]}\n'
  const urls: string[] = []
  const served = bodyHttp(body)
  const http: HttpClient = async (url, init) => { urls.push(url); return served(url, init) }

  const r = await cli(memDb(), ['probe', 'posta', 'ra 123456785 sk'], { http })

  expect(r.code).toBe(0)
  expect(r.out).toEqual([body])
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain('RA123456785SK')
  expect(r.err).toMatch(/"status":"pre_transit"/)
})

test('probe refuses an unknown carrier without touching the network', async () => {
  const http: HttpClient = async () => { throw new Error('network must not be used') }
  const r = await cli(memDb(), ['probe', 'ups', 'X1'], { http })
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/unknown carrier "ups"/)
})

test('poll runs the orchestrator over the injected adapters and prints the summary', async () => {
  const db = memDb()
  insertParcel(db, { carrier: 'posta', trackingNumber: 'RA123456785SK', source: 'manual' })
  const posta = stubAdapter('posta', ins => ins.map(i => okResult(i.number, [ev('2026-10-26 09:00:00', 'in_transit', 0)])), 100)

  const r = await cli(db, ['poll'], { adapters: [posta], http: bodyHttp() })

  expect(r.code).toBe(0)
  expect(r.out[0]).toMatch(/polled 1 parcel\(s\), 1 new event\(s\)/)
  expect(findParcel(db, 'posta', 'RA123456785SK')?.status).toBe('in_transit')
})

test('an unknown flag or command is a usage message and exit 1, not a stack trace', async () => {
  const flag = await cli(memDb(), ['add', 'RA123456785SK', '--bogus'])
  expect(flag.code).toBe(1)
  expect(flag.err).toMatch(/usage:/)
  const cmd = await cli(memDb(), ['frobnicate'])
  expect(cmd.code).toBe(1)
  expect(cmd.err).toMatch(/unknown command "frobnicate"/)
})

test('probe still prints the response body when the adapter throws while parsing it', async () => {
  const body = '{"results":[{"number":"X","sta'
  const sps = stubAdapter('sps', async (_ins, http) => {
    JSON.parse(await (await http('https://sps.example')).text())
    return []
  })
  register(sps)

  const r = await cli(memDb(), ['probe', 'sps', '7031234567890123'], { http: bodyHttp(body) })

  expect(r.code).toBe(1)
  expect(r.out).toEqual([body])
  expect(r.err).toMatch(/probe failed/)
})
