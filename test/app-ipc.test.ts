import { test, expect, afterEach, vi } from 'vitest'
import { isToServer, postToMain, setMainChannel, type ToMain } from '../src/core/app-ipc.js'

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
