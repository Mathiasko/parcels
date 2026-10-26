import { test, expect } from 'vitest'
import { parseNaive } from '../src/core/time.js'

test('parses a naive Slovak timestamp as Europe/Bratislava, not UTC', () => {
  expect(parseNaive('2026-07-13T15:08:08', 'Europe/Bratislava').at.toISOString())
    .toBe('2026-07-13T13:08:08.000Z')   // CEST = UTC+2
})
test('parses a winter timestamp at UTC+1', () => {
  expect(parseNaive('2026-01-13T15:08:08', 'Europe/Bratislava').at.toISOString())
    .toBe('2026-01-13T14:08:08.000Z')
})
test('a non-existent local time in the spring-forward gap resolves forward, not NaN', () => {
  const r = parseNaive('2026-03-29T02:30:00', 'Europe/Bratislava')   // 02:00->03:00
  expect(Number.isNaN(r.at.getTime())).toBe(false)
})
test('an ambiguous local time in the autumn fold picks the earlier offset deterministically', () => {
  const r = parseNaive('2026-10-25T02:30:00', 'Europe/Bratislava')
  expect(r.at.toISOString()).toBe('2026-10-25T00:30:00.000Z')
})
test('parses the Packeta space-separated format in Europe/Prague', () => {
  expect(parseNaive('2026-04-29 13:12:42', 'Europe/Prague').at.toISOString())
    .toBe('2026-04-29T11:12:42.000Z')
})
test('throws on an unparseable string rather than returning Invalid Date', () => {
  expect(() => parseNaive('not a date', 'Europe/Bratislava')).toThrow()
})
test('times adjacent to the autumn fold are unaffected by fold handling', () => {
  expect(parseNaive('2026-10-25T01:59:59', 'Europe/Bratislava').at.toISOString()).toBe('2026-10-24T23:59:59.000Z')
  expect(parseNaive('2026-10-25T03:00:00', 'Europe/Bratislava').at.toISOString()).toBe('2026-10-25T02:00:00.000Z')
})
test('the spring-forward gap resolves forward to 03:30 CEST', () => {
  expect(parseNaive('2026-03-29T02:30:00', 'Europe/Bratislava').at.toISOString()).toBe('2026-03-29T01:30:00.000Z')
})
test('an explicit format is honoured', () => {
  expect(parseNaive('13.07.2026 15:08', 'Europe/Bratislava', 'dd.MM.yyyy HH:mm').at.toISOString())
    .toBe('2026-07-13T13:08:00.000Z')
})
