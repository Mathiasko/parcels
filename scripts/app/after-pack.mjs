// electron-builder's afterPack hook: flips the Electron fuses, then signs the packed app with
// "Parcels Signing". The zip and dmg are made after this hook, from the app it signed.
//
// Why a hook, and not electron-builder's own `mac.identity` (spec §10): electron-builder only signs
// with identities `security find-identity -v` lists, which means trusted ones. "Parcels Signing" is
// self-signed and untrusted, so electron-builder skips signing with it, while codesign signs with it
// without complaint. So electron-builder.yml sets `mac.identity: null`, and this hook calls
// @electron/osx-sign (electron-builder's own signer) with identity validation turned off.
//
// Why the fuses are flipped here: electron-builder flips them after afterPack, and flipping changes
// the Electron Framework binary, which would break a signature made before it. So this hook flips them
// first, from the same `electronFuses` setting, and signs after. electron-builder's own flip, which
// still follows, then writes the same bytes again and the signature stays valid; the release build
// checks that with `codesign --verify --deep --strict`.
import { join } from 'node:path'
import { signAsync } from '@electron/osx-sign'

/** The identity's name in the login keychain; scripts/app/make-signing-cert.sh creates it. */
const IDENTITY = 'Parcels Signing'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const packager = context.packager
  const app = join(context.appOutDir, `${packager.appInfo.productFilename}.app`)

  const fuses = packager.config.electronFuses
  if (fuses) await packager.addElectronFuses(context, await packager.generateFuseConfig(fuses))

  console.log(`  • signing with "${IDENTITY}" (after-pack hook)  app=${app}`)
  await signAsync({
    app,
    identity: IDENTITY,
    // Validation looks the identity up with `find-identity -v`, which hides untrusted identities.
    identityValidation: false,
    platform: 'darwin',
    // The app needs no entitlements: no sandbox and no hardened runtime, so nothing to grant.
    preAutoEntitlements: false,
    // No hardened runtime: a self-signed app cannot be notarized, which is what it would be for. No
    // timestamp: Apple's timestamp server failed mid-build in the spike, and a self-signed signature
    // gains nothing from one.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  })
}
