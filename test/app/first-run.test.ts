import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  decideFirstRun, fillPage, plistWorkingDirectory, writeWelcomeConfig,
} from '../../app/first-run.js'
import { loadConfig } from '../../src/core/config.js'

const mode = (path: string) => statSync(path).mode & 0o777
const tmp = () => mkdtempSync(join(tmpdir(), 'parcels-first-run-'))

/** A launchd plist as install-agents.sh writes it, with `dir` as the WorkingDirectory (already XML). */
const plist = (label: string, dir: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${dir}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`

/** A home folder: an empty support folder's parent, a LaunchAgents folder, and optionally a clone. */
function home() {
  const root = tmp()
  const support = join(root, 'Library', 'Application Support', 'Parcels')
  const launchAgents = join(root, 'Library', 'LaunchAgents')
  mkdirSync(launchAgents, { recursive: true })
  const clone = join(root, 'Desktop', 'parcels')
  mkdirSync(clone, { recursive: true })
  return { root, support, config: join(support, 'config.json'), launchAgents, clone }
}

describe('decideFirstRun', () => {
  test('a config in the support folder means the app is set up', () => {
    const h = home()
    mkdirSync(h.support, { recursive: true })
    writeFileSync(h.config, '{"defaultPostalCode":"81101"}')
    // Even with an old install still present: the app already moved in, or was set up fresh.
    writeFileSync(join(h.clone, 'config.json'), '{}')
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', h.clone))
    expect(decideFirstRun(h)).toEqual({ kind: 'ready' })
  })

  test('a web plist whose WorkingDirectory holds a config.json means move in, with both plists', () => {
    const h = home()
    writeFileSync(join(h.clone, 'config.json'), '{}')
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', h.clone))
    writeFileSync(join(h.launchAgents, 'local.parcels.poller.plist'), plist('local.parcels.poller', h.clone))
    expect(decideFirstRun(h)).toEqual({
      kind: 'move-in',
      clone: h.clone,
      // The poller first: it is the one that writes on its own, so it is stopped first.
      plists: [join(h.launchAgents, 'local.parcels.poller.plist'), join(h.launchAgents, 'local.parcels.web.plist')],
    })
  })

  test('only the plists that exist are listed', () => {
    const h = home()
    writeFileSync(join(h.clone, 'config.json'), '{}')
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', h.clone))
    expect(decideFirstRun(h)).toEqual({
      kind: 'move-in', clone: h.clone, plists: [join(h.launchAgents, 'local.parcels.web.plist')],
    })
  })

  test('the WorkingDirectory is read with its XML entities undone', () => {
    const h = home()
    const odd = join(h.root, 'Tom & Jerry <parcels>')
    mkdirSync(odd)
    writeFileSync(join(odd, 'config.json'), '{}')
    const xml = join(h.root, 'Tom &amp; Jerry &lt;parcels&#62;')
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', xml))
    expect(decideFirstRun(h)).toMatchObject({ kind: 'move-in', clone: odd })
  })

  test('a web plist pointing at a missing folder means welcome', () => {
    const h = home()
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', join(h.root, 'gone')))
    expect(decideFirstRun(h)).toEqual({ kind: 'welcome' })
  })

  test('a web plist pointing at a folder with no config.json means welcome', () => {
    const h = home()
    writeFileSync(join(h.launchAgents, 'local.parcels.web.plist'), plist('local.parcels.web', h.clone))
    expect(decideFirstRun(h)).toEqual({ kind: 'welcome' })
  })

  test('only a poller plist (no web plist) means welcome, as the spec keys on the web plist', () => {
    const h = home()
    writeFileSync(join(h.clone, 'config.json'), '{}')
    writeFileSync(join(h.launchAgents, 'local.parcels.poller.plist'), plist('local.parcels.poller', h.clone))
    expect(decideFirstRun(h)).toEqual({ kind: 'welcome' })
  })

  test('nothing at all means welcome', () => {
    const h = home()
    expect(decideFirstRun(h)).toEqual({ kind: 'welcome' })
    expect(decideFirstRun({ config: '/nowhere/config.json', launchAgents: '/nowhere/LaunchAgents' })).toEqual({ kind: 'welcome' })
  })

  test('the file system can be injected, and an unreadable plist means welcome', () => {
    const files: Record<string, string> = {
      '/h/LaunchAgents/local.parcels.web.plist': plist('local.parcels.web', '/c/parcels'),
      '/c/parcels/config.json': '{}',
    }
    const fs = {
      existsSync: (p: unknown) => String(p) in files,
      readFileSync: ((p: unknown) => {
        const v = files[String(p)]
        if (v === undefined) throw new Error('ENOENT')
        return v
      }) as never,
    }
    expect(decideFirstRun({ config: '/s/config.json', launchAgents: '/h/LaunchAgents' }, fs)).toEqual({
      kind: 'move-in', clone: '/c/parcels', plists: ['/h/LaunchAgents/local.parcels.web.plist'],
    })
    const unreadable = { ...fs, readFileSync: (() => { throw new Error('EACCES') }) as never }
    expect(decideFirstRun({ config: '/s/config.json', launchAgents: '/h/LaunchAgents' }, unreadable)).toEqual({ kind: 'welcome' })
  })
})

describe('plistWorkingDirectory', () => {
  const doc = (inner: string) => `<plist version="1.0"><dict>${inner}</dict></plist>`

  test('reads the string after the key, across whitespace and newlines', () => {
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key>\n\t  <string>/Users/a/parcels</string>'))).toBe('/Users/a/parcels')
  })

  test('undoes the five named entities and numeric references', () => {
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>/a&amp;b&lt;c&gt;d&quot;e&apos;f&#47;g&#x2F;h</string>')))
      .toBe('/a&b<c>d"e\'f/g/h')
  })

  test('refuses what a strict reading cannot trust', () => {
    // No key, no string after it, an empty string, a relative path.
    expect(plistWorkingDirectory(doc('<key>Label</key><string>x</string>'))).toBeUndefined()
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><true/>'))).toBeUndefined()
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string></string>'))).toBeUndefined()
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>parcels</string>'))).toBeUndefined()
    // Something between the key and its string (another key) is not "followed by".
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><key>X</key><string>/a</string>'))).toBeUndefined()
    // A bare ampersand or an unknown entity is not well-formed XML.
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>/a & b</string>'))).toBeUndefined()
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>/a&nbsp;b</string>'))).toBeUndefined()
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>/a&#0;b</string>'))).toBeUndefined()
    // Two answers are no answer.
    expect(plistWorkingDirectory(doc('<key>WorkingDirectory</key><string>/a</string><key>WorkingDirectory</key><string>/b</string>'))).toBeUndefined()
  })
})

describe('writeWelcomeConfig', () => {
  test('strips whitespace from the postcode and writes the document setup.sh writes, at mode 0600', () => {
    const h = home()
    writeWelcomeConfig(h.config, ' 811 01 ')
    expect(mode(h.config)).toBe(0o600)
    // The support folder did not exist; it is made owner-only.
    expect(mode(h.support)).toBe(0o700)
    // setup.sh: config.example.json, minus the imap placeholders, with the postcode.
    const example = JSON.parse(readFileSync(join(import.meta.dirname, '../../config.example.json'), 'utf8')) as Record<string, unknown>
    delete example.imap
    expect(JSON.parse(readFileSync(h.config, 'utf8'))).toEqual({ ...example, defaultPostalCode: '81101' })
    expect(loadConfig(h.config).defaultPostalCode).toBe('81101')
  })

  test('anything but five digits throws and writes nothing', () => {
    for (const bad of ['8110', '811011', '8110a', '', '   ', '８１１０１']) {
      const h = home()
      expect(() => writeWelcomeConfig(h.config, bad)).toThrow()
      expect(existsSync(h.config)).toBe(false)
    }
  })

  test('an existing config is never overwritten', () => {
    const h = home()
    mkdirSync(h.support, { recursive: true })
    writeFileSync(h.config, '{"defaultPostalCode":"01001","imap":"kept"}')
    expect(() => writeWelcomeConfig(h.config, '81101')).toThrow()
    expect(readFileSync(h.config, 'utf8')).toBe('{"defaultPostalCode":"01001","imap":"kept"}')
  })
})

describe('fillPage', () => {
  test('fills every placeholder, HTML-escaped', () => {
    expect(fillPage('<p title="{{a}}">{{b}}</p>{{a}}', { a: '"x"&', b: '<script>' }))
      .toBe('<p title="&quot;x&quot;&amp;">&lt;script&gt;</p>&quot;x&quot;&amp;')
  })

  test('a placeholder with no value, or a value with no placeholder, is a bug and throws', () => {
    expect(() => fillPage('{{a}}{{b}}', { a: '' })).toThrow(/b/)
    expect(() => fillPage('{{a}}', { a: '', c: '' })).toThrow(/c/)
  })

  test('the stylesheet goes in as it is, since CSS is not HTML text, and cannot close its element', () => {
    expect(fillPage('<style>{{style}}</style><p>{{a}}</p>', { a: '>' }, '.n>div{font:"x"}'))
      .toBe('<style>.n>div{font:"x"}</style><p>&gt;</p>')
    expect(() => fillPage('<style>{{style}}</style>', {}, 'a{}</style><script>')).toThrow()
    expect(() => fillPage('<style>{{style}}</style>', { style: 'x' })).toThrow(/style/)
  })

  test('a value that looks like a placeholder is not filled again', () => {
    expect(fillPage('{{a}} {{b}}', { a: '{{b}}', b: 'x' })).toBe('{{b}} x')
  })
})

describe('the pages', () => {
  const page = (name: string) => readFileSync(join(import.meta.dirname, '../../app/pages', name), 'utf8')
  // The real stylesheet: it must survive the filling untouched.
  const STYLE = '.notice>div{font:"x"}'

  test('have no JavaScript, and no reference to anything outside the page', () => {
    for (const name of ['welcome.html', 'move-in.html', 'result.html']) {
      const html = page(name)
      expect(html).not.toMatch(/<script|\son\w+=|javascript:/i)
      expect(html).not.toMatch(/\s(src|href)=/i)
      expect(html).toContain('{{style}}')
    }
  })

  test('welcome says what the spec says, and posts the postcode to parcels://welcome', () => {
    const html = fillPage(page('welcome.html'), { error: '', postcode: '', theme: 'postal', mode: 'system' }, STYLE)
    expect(html).toContain('<h1>Welcome to Parcels</h1>')
    expect(html).toContain('Parcels tracks your parcels from your shipping emails. First, the postcode some carriers ask for.')
    expect(html).toMatch(/<form method="post" action="parcels:\/\/welcome\/">/)
    expect(html).toMatch(/name="postcode"/)
    expect(html).toContain(`<style>${STYLE}`)
  })

  test('move in names the clone, offers Move in and Not now (quit), and posts to parcels://move-in', () => {
    const html = fillPage(page('move-in.html'), { clone: '/Users/a/Desktop/parcels', theme: 'postal', mode: 'system' }, STYLE)
    expect(html).toContain('<h1>Move your parcels into the app</h1>')
    expect(html.replace(/\s+/g, ' ')).toContain(
      'Parcels is already installed in <span class="mono">/Users/a/Desktop/parcels</span>. Move your parcels, settings and Gmail connection into the app? The folder is left as it is.')
    expect(html).toMatch(/<form method="post" action="parcels:\/\/move-in\/">/)
    expect(html).toMatch(/<button class="pri" name="action" value="move">Move in<\/button>/)
    expect(html).toMatch(/<button name="action" value="quit">Not now \(quit\)<\/button>/)
  })

  test('the result page shows the step and the reason', () => {
    const html = fillPage(page('result.html'), {
      step: 'Copying your parcels', reason: 'file is not a database', clone: '/c', theme: 'classic', mode: 'dark',
      ledeStart: 'Nothing was moved, and ', ledeEnd: ' is as it was.', next: 'You can try again.',
    }, STYLE)
    expect(html).toContain('<html lang="en" data-theme="classic" data-mode="dark">')
    expect(html).toContain('Copying your parcels')
    expect(html).toContain('file is not a database')
    expect(html).toMatch(/action="parcels:\/\/move-in\/"/)
  })
})
