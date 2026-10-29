import { test, expect, afterEach, vi } from 'vitest'
import { isToMain, isToServer, postToMain, setMainChannel, type ToMain } from '../src/core/app-ipc.js'

afterEach(() => setMainChannel(undefined))

test('isToServer accepts the three server messages', () => {
  expect(isToServer({ type: 'refresh' })).toBe(true)
  expect(isToServer({ type: 'wake' })).toBe(true)
  expect(isToServer({ type: 'shutdown' })).toBe(true)
})

test('isToServer rejects a message meant for main, null and a bare string', () => {
  expect(isToServer({ type: 'install' })).toBe(false)
  expect(isToServer(null)).toBe(false)
  expect(isToServer('refresh')).toBe(false)
  expect(isToServer(undefined)).toBe(false)
  expect(isToServer({})).toBe(false)
})

test('postToMain says false when no channel is set, so the git host falls back', () => {
  expect(postToMain({ type: 'ready-count', n: 1 })).toBe(false)
})

test('postToMain hands the message to the channel and says true', () => {
  const post = vi.fn<(m: ToMain) => void>()
  setMainChannel(post)
  const m: ToMain = { type: 'listening', port: 8787 }
  expect(postToMain(m)).toBe(true)
  expect(post).toHaveBeenCalledExactlyOnceWith(m)
})

test('setMainChannel(undefined) clears the channel', () => {
  setMainChannel(() => {})
  setMainChannel(undefined)
  expect(postToMain({ type: 'ready-count', n: 0 })).toBe(false)
})

test('isToMain accepts each message the server sends', () => {
  expect(isToMain({ type: 'notify', groupKey: 'g', title: 't', message: 'm' })).toBe(true)
  expect(isToMain({ type: 'notify', groupKey: 'g', title: 't', message: 'm', url: '/parcel/1' })).toBe(true)
  expect(isToMain({ type: 'ready-count', n: 0 })).toBe(true)
  expect(isToMain({ type: 'install', staged: '/s/Parcels.app', version: '0.2.0' })).toBe(true)
  expect(isToMain({ type: 'reveal', path: '/h/Library/Application Support/Parcels' })).toBe(true)
  expect(isToMain({ type: 'listening', port: 8799 })).toBe(true)
})

test('isToMain rejects unknown types, server messages and wrongly shaped fields', () => {
  expect(isToMain({ type: 'refresh' })).toBe(false)
  expect(isToMain({ type: 'exec', cmd: 'rm' })).toBe(false)
  expect(isToMain(null)).toBe(false)
  expect(isToMain('notify')).toBe(false)
  expect(isToMain({ type: 'notify', groupKey: 'g', title: 't' })).toBe(false)
  expect(isToMain({ type: 'notify', groupKey: 'g', title: 't', message: 'm', url: 5 })).toBe(false)
  expect(isToMain({ type: 'ready-count', n: -1 })).toBe(false)
  expect(isToMain({ type: 'ready-count', n: 1.5 })).toBe(false)
  expect(isToMain({ type: 'ready-count', n: '2' })).toBe(false)
  expect(isToMain({ type: 'install', staged: '/s' })).toBe(false)
  expect(isToMain({ type: 'reveal', path: 7 })).toBe(false)
  expect(isToMain({ type: 'listening', port: 0 })).toBe(false)
  expect(isToMain({ type: 'listening', port: 70000 })).toBe(false)
})
