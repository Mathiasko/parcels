#!/bin/bash
# Builds both Macs' apps for a release into release/ and checks every artifact the way the installed
# app will check it. Publishes nothing: release.sh calls this, then asks before it publishes.
#
#   scripts/app/build-release.sh
#
# Steps, each a reason to stop:
#   1. `npm ci` (exactly the lockfile), then `npm run app:dist`: build:app and electron-builder, which
#      signs both apps with "Parcels Signing" through scripts/app/after-pack.mjs.
#   2. release/SHA256SUMS over the four artifacts, as the updater reads it.
#   3. Both .apps, and the app inside each .dmg: `codesign --verify --deep --strict`, the leaf
#      certificate's SHA-256 equal to app/signing-cert.sha256, and the RunAsNode fuse off.
#   4. Each zip through check-release-zip.mjs: the updater's own checks, from dist/, against the
#      committed certificate hash and this version.
#   5. A smoke start of this Mac's app (smoke.sh --no-build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=../lib/node.sh
. "$ROOT/scripts/lib/node.sh"
require_node build-release || exit 1

version="$(/usr/bin/plutil -extract version raw -o - package.json)"
want="$(tr -d '[:space:]' < app/signing-cert.sha256)"
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "build-release: app/signing-cert.sha256 is not a SHA-256." >&2; exit 1; }

step() { printf '\n== %s\n' "$1"; }
die() { echo "build-release: $1" >&2; exit 1; }

# Old artifacts must not be published by mistake beside the new ones.
step "Clearing release/"
rm -rf "$ROOT/release"

step "Installing exactly the lockfile (npm ci)"
run_npm "$ROOT" ci

step "Building and signing Parcels $version for arm64 and x64"
run_npm "$ROOT" run app:dist

artifacts=("Parcels-$version-arm64.zip" "Parcels-$version-x64.zip" "Parcels-$version-arm64.dmg" "Parcels-$version-x64.dmg")
for a in "${artifacts[@]}"; do [ -f "release/$a" ] || die "electron-builder did not make release/$a"; done

step "Writing release/SHA256SUMS"
(cd release && shasum -a 256 "${artifacts[@]}" > SHA256SUMS)
cat release/SHA256SUMS

# check_app <label> <path/to/Parcels.app>: the signature holds, it is ours, and the fuse is off.
check_app() {
  local label="$1" app="$2" certs got
  codesign --verify --deep --strict "$app" || die "$label: codesign --verify failed"
  certs="$(mktemp -d)"
  codesign -d --extract-certificates="$certs/c" "$app" 2>/dev/null || { rm -rf "$certs"; die "$label: could not read its certificates"; }
  got="$(shasum -a 256 "$certs/c0" | awk '{ print $1 }')"
  rm -rf "$certs"
  [ "$got" = "$want" ] || die "$label: signed by leaf $got, not the committed $want"
  # Fuse 0 is RunAsNode; "0" (48) means disabled. Read by electron-builder's own @electron/fuses.
  "$NODE" -e "require('@electron/fuses').getCurrentFuseWire(process.argv[1]).then(w => process.exit(w[0] === 48 ? 0 : 1))" "$app" \
    || die "$label: the RunAsNode fuse is not disabled"
  echo "$label: signature valid, leaf $got, RunAsNode off"
}

step "Checking the signatures"
check_app "arm64 app" "release/mac-arm64/Parcels.app"
check_app "x64 app" "release/mac/Parcels.app"
for arch in arm64 x64; do
  mnt="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "release/Parcels-$version-$arch.dmg" >/dev/null \
    || die "could not open release/Parcels-$version-$arch.dmg"
  rc=0
  (check_app "$arch dmg" "$mnt/Parcels.app") || rc=$?
  hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt" || true
  rmdir "$mnt" 2>/dev/null || true
  [ "$rc" = 0 ] || exit "$rc"
done

step "Running each zip through the updater's own checks"
for arch in arm64 x64; do
  "$NODE" scripts/app/check-release-zip.mjs "release/Parcels-$version-$arch.zip" "$version" app/signing-cert.sha256 release/SHA256SUMS \
    || die "release/Parcels-$version-$arch.zip would be refused by the updater"
done

step "Smoke-testing this Mac's app"
bash scripts/app/smoke.sh --no-build || die "the smoke test failed"

step "Built and checked Parcels $version"
for a in "${artifacts[@]}" SHA256SUMS; do printf '  release/%s  (%s bytes)\n' "$a" "$(stat -f %z "release/$a")"; done
