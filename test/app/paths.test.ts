import { expect, test } from 'vitest'
import { appPaths, bundlePath } from '../../app/paths.js'

test('appPaths puts the support folder, config, logs and launch agents under the home folder', () => {
  expect(appPaths('/h')).toEqual({
    support: '/h/Library/Application Support/Parcels',
    config: '/h/Library/Application Support/Parcels/config.json',
    logs: '/h/Library/Logs/Parcels',
    launchAgents: '/h/Library/LaunchAgents',
  })
})

test('bundlePath walks up from the executable to the .app folder', () => {
  expect(bundlePath('/Applications/Parcels.app/Contents/MacOS/Parcels')).toBe('/Applications/Parcels.app')
  // A dev run is Electron's own bundle; still a .app, just not ours.
  expect(bundlePath('/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
    .toBe('/r/node_modules/electron/dist/Electron.app')
  expect(bundlePath('/Volumes/My Disk/A b.app/Contents/MacOS/A b')).toBe('/Volumes/My Disk/A b.app')
})

test('bundlePath gives an empty string for an executable that is not inside a bundle', () => {
  expect(bundlePath('/usr/local/bin/electron')).toBe('')
})
