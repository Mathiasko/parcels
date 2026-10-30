import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { buildServer } from '../src/web/server.js'
import type { Config } from '../src/core/config.js'
import { config, memDb, NOW } from './poll-helpers.js'

/** A temp config path, so /settings never reads the user's own config.json. */
const configPath = () => join(mkdtempSync(join(tmpdir(), 'parcels-appearance-')), 'config.json')

const server = (db = memDb(), c: Config = config) =>
  buildServer({ db, config: c, configPath: configPath(), now: () => NOW, notifier: { send: async () => {} } })

const head = (a: string, b: string) => `<html lang="en" data-theme="${a}" data-mode="${b}">`

describe('every page names its theme and mode on <html>', () => {
  test('the configured appearance is on the dashboard, settings, health and the 404 page', async () => {
    const app = server(memDb(), { ...config, appearance: { theme: 'classic', mode: 'dark' } })
    for (const url of ['/', '/settings', '/health', '/no/such/page']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body, url).toContain(head('classic', 'dark'))
    }
  })

  test('a config with no appearance gets the defaults, postal and system', async () => {
    const app = server()
    for (const url of ['/', '/settings', '/health', '/no/such/page']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.body, url).toContain(head('postal', 'system'))
    }
  })

  test('the error page, rendered when the database is down, still carries the configured theme', async () => {
    const db = memDb()
    const app = server(db, { ...config, appearance: { theme: 'classic', mode: 'light' } })
    db.close()   // ctx() now throws, so errorCtx() falls back
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.inject({ method: 'GET', url: '/' })
      expect(res.statusCode).toBe(500)
      expect(res.body).toContain(head('classic', 'light'))
    } finally {
      spy.mockRestore()
    }
  })
})
