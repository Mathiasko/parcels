import { describe, expect, test } from 'vitest'
import { isUnstableLocation, MOVE_DETAIL, MOVE_QUESTION, offerMoveToApplications, type MoveOfferDeps } from '../../app/location.js'

describe('isUnstableLocation', () => {
  const home = '/Users/u'

  test('a disk image, an App Translocation copy and the Downloads folder are unstable', () => {
    expect(isUnstableLocation('/Volumes/Parcels/Parcels.app', home)).toBe(true)
    expect(isUnstableLocation('/private/var/folders/x/AppTranslocation/y/d/Parcels.app', home)).toBe(true)
    expect(isUnstableLocation('/Users/u/Downloads/Parcels.app', home)).toBe(true)
    expect(isUnstableLocation('/Users/u/Downloads/unzipped/Parcels.app', home)).toBe(true)
  })

  test('the Applications folders are stable', () => {
    expect(isUnstableLocation('/Applications/Parcels.app', home)).toBe(false)
    expect(isUnstableLocation('/Users/u/Applications/Parcels.app', home)).toBe(false)
  })

  test('only the Downloads folder itself counts, and a home given with a trailing slash still matches', () => {
    expect(isUnstableLocation('/Users/u/Downloads-old/Parcels.app', home)).toBe(false)
    expect(isUnstableLocation('/Users/other/Downloads/Parcels.app', home)).toBe(false)
    expect(isUnstableLocation('/Users/u/Downloads/Parcels.app', '/Users/u/')).toBe(true)
  })

  test('a path that is not in a bundle (an empty string) is never unstable', () => {
    expect(isUnstableLocation('', home)).toBe(false)
  })
})

describe('offerMoveToApplications', () => {
  const setup = (over: Partial<MoveOfferDeps> & { answer?: boolean; moves?: boolean | Error } = {}) => {
    const asked: number[] = []
    const moved: number[] = []
    const logged: string[] = []
    const deps: MoveOfferDeps = {
      packaged: true,
      bundle: '/Users/u/Downloads/Parcels.app',
      home: '/Users/u',
      ask: async () => { asked.push(1); return over.answer ?? true },
      move: () => {
        moved.push(1)
        if (over.moves instanceof Error) throw over.moves
        return over.moves ?? true
      },
      log: line => logged.push(line),
      ...over,
    }
    return { deps, asked, moved, logged }
  }

  test('the question says what it asks and why, in the words the brief gives', () => {
    expect(`${MOVE_QUESTION} ${MOVE_DETAIL}`).toBe('Move Parcels to your Applications folder? It needs to live there to update itself.')
  })

  test('an unpackaged dev run is never asked, wherever node_modules is', async () => {
    const s = setup({ packaged: false })
    expect(await offerMoveToApplications(s.deps)).toBe('not-packaged')
    expect(s.asked).toEqual([])
    expect(s.moved).toEqual([])
  })

  test('an app already in a stable place is not asked', async () => {
    const s = setup({ bundle: '/Applications/Parcels.app' })
    expect(await offerMoveToApplications(s.deps)).toBe('stable')
    expect(s.asked).toEqual([])
  })

  test('yes moves the app', async () => {
    const s = setup({ answer: true })
    expect(await offerMoveToApplications(s.deps)).toBe('moved')
    expect(s.asked).toHaveLength(1)
    expect(s.moved).toHaveLength(1)
  })

  test('no leaves it where it is, and asks only the once', async () => {
    const s = setup({ answer: false })
    expect(await offerMoveToApplications(s.deps)).toBe('declined')
    expect(s.asked).toHaveLength(1)
    expect(s.moved).toEqual([])
  })

  test('a move the user cancels in its own dialog carries on from where the app is', async () => {
    const s = setup({ moves: false })
    expect(await offerMoveToApplications(s.deps)).toBe('not-moved')
  })

  test('a move that throws is logged and the app carries on', async () => {
    const s = setup({ moves: new Error('EACCES') })
    expect(await offerMoveToApplications(s.deps)).toBe('failed')
    expect(s.logged.join('\n')).toMatch(/EACCES/)
  })

  test('a dialog that throws is logged and counts as no', async () => {
    const s = setup({ ask: async () => { throw new Error('no window server') } })
    expect(await offerMoveToApplications(s.deps)).toBe('failed')
    expect(s.moved).toEqual([])
    expect(s.logged.join('\n')).toMatch(/no window server/)
  })
})
