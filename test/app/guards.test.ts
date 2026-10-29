import { expect, test } from 'vitest'
import {
  dashboardOrigin, downloadName, isDashboardUrl, isFirstRunUrl, isInside, isWebUrl, notificationPath,
} from '../../app/guards.js'

test('dashboardOrigin is the loopback origin on the port', () => {
  expect(dashboardOrigin(8799)).toBe('http://127.0.0.1:8799')
})

test('isDashboardUrl accepts only http on 127.0.0.1 at the exact port', () => {
  expect(isDashboardUrl('http://127.0.0.1:8799/parcel/3?x=1#y', 8799)).toBe(true)
  expect(isDashboardUrl('http://127.0.0.1:8799', 8799)).toBe(true)
  expect(isDashboardUrl('http://127.0.0.1:8787/', 8799)).toBe(false)
  expect(isDashboardUrl('https://127.0.0.1:8799/', 8799)).toBe(false)
  expect(isDashboardUrl('http://localhost:8799/', 8799)).toBe(false)
  expect(isDashboardUrl('http://127.0.0.1:8799@evil.example/', 8799)).toBe(false)
  expect(isDashboardUrl('file:///etc/passwd', 8799)).toBe(false)
  expect(isDashboardUrl('not a url', 8799)).toBe(false)
})

test('isWebUrl allows http and https only, so the default browser never runs a file or a script', () => {
  expect(isWebUrl('https://tracking.example/x')).toBe(true)
  expect(isWebUrl('http://example.com')).toBe(true)
  expect(isWebUrl('file:///Applications/Calculator.app')).toBe(false)
  expect(isWebUrl('javascript:alert(1)')).toBe(false)
  expect(isWebUrl('mailto:a@b.c')).toBe(false)
  expect(isWebUrl('smb://host/share')).toBe(false)
  expect(isWebUrl('')).toBe(false)
})

test('notificationPath keeps a dashboard path and reduces a loopback dashboard URL to its path', () => {
  expect(notificationPath('/parcel/12')).toBe('/parcel/12')
  expect(notificationPath('/health#update')).toBe('/health#update')
  // The server builds its links as http://127.0.0.1:<port>/..., so only the path is kept.
  expect(notificationPath('http://127.0.0.1:8787/parcel/12?a=1#b')).toBe('/parcel/12?a=1#b')
  expect(notificationPath(undefined)).toBe('/')
})

test('notificationPath turns anything else into /, never an outside address', () => {
  expect(notificationPath('https://evil.example/x')).toBe('/')
  expect(notificationPath('http://localhost:8787/x')).toBe('/')
  expect(notificationPath('//evil.example/x')).toBe('/')
  expect(notificationPath('/\\evil.example')).toBe('/')
  expect(notificationPath('javascript:alert(1)')).toBe('/')
  expect(notificationPath('parcel/12')).toBe('/')
  expect(notificationPath('')).toBe('/')
})

test('isInside accepts a root and what is below it, nothing beside or above it', () => {
  expect(isInside('/h/Support/Parcels', ['/h/Support/Parcels'])).toBe(true)
  expect(isInside('/h/Support/Parcels/data', ['/x', '/h/Support/Parcels'])).toBe(true)
  expect(isInside('/h/Support/Parcels-evil', ['/h/Support/Parcels'])).toBe(false)
  expect(isInside('/h/Support/Parcels/../../bin', ['/h/Support/Parcels'])).toBe(false)
  expect(isInside('relative/path', ['/h'])).toBe(false)
})

test('downloadName keeps the base name and picks a free one when the file exists', () => {
  const taken = new Set(['/d/gmail-filter.xml', '/d/gmail-filter (1).xml'])
  const exists = (p: string) => taken.has(p)
  expect(downloadName('/d', 'report.txt', exists)).toBe('/d/report.txt')
  expect(downloadName('/d', 'gmail-filter.xml', exists)).toBe('/d/gmail-filter (2).xml')
  // A name the server suggests cannot climb out of Downloads.
  expect(downloadName('/d', '../../.zshrc', exists)).toBe('/d/.zshrc')
  expect(downloadName('/d', '', exists)).toBe('/d/download')
  expect(downloadName('/d', '..', exists)).toBe('/d/download')
})

test('isFirstRunUrl accepts the two first-run pages and nothing else on the scheme', () => {
  expect(isFirstRunUrl('parcels://welcome/')).toBe(true)
  expect(isFirstRunUrl('parcels://move-in/')).toBe(true)
  for (const url of [
    'parcels://welcome/x', 'parcels://result/', 'parcels://u:p@welcome/', 'parcels://welcome:1/',
    'http://welcome/', 'http://127.0.0.1:8787/', 'file:///welcome/', 'parcels:welcome', 'not a url',
  ]) expect(isFirstRunUrl(url), url).toBe(false)
})
