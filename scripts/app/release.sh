#!/bin/bash
# Builds, checks and publishes one release of the Mac app to GitHub Releases (spec §5).
#
#   scripts/app/release.sh [--notes-file FILE] [--yes]      or: npm run release -- [...]
#
# How to cut a release:
#   1. Bump "version" in package.json, commit it, and leave the tree clean.
#   2. Run this script on the Mac that holds the "Parcels Signing" identity (make-signing-cert.sh made
#      it), logged into GitHub with `gh auth login`.
#   3. It refuses, before building anything, a dirty tree, a tag v<version> that already exists here
#      or on GitHub, a keychain without "Parcels Signing", or a gh that is not logged in.
#   4. scripts/app/build-release.sh then builds both Macs' apps from a clean `npm ci`, signs them,
#      writes release/SHA256SUMS, and checks every artifact the way the installed app will: the
#      signature and its certificate, each zip through the app's own update checks, and a smoke start.
#      Any failure stops here, with nothing tagged or published.
#   5. It lists the five assets and asks "Publish v<version> to GitHub? [y/N]" (skipped with --yes).
#   6. Only then: `git tag v<version>`, `git push origin v<version>`, and `gh release create` with the
#      five assets. Friends' apps see the release at their next daily check.
#
# Without --notes-file, GitHub writes the notes from the commits since the last release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_SLUG="Mathiasko/parcels"
IDENTITY="Parcels Signing"

notes=""
yes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --notes-file)
      [ "$#" -ge 2 ] || { echo "release: --notes-file needs a file name." >&2; exit 1; }
      notes="$2"; shift 2 ;;
    --yes) yes=1; shift ;;
    *) echo "release: \"$1\" is not an option this script knows; it takes --notes-file FILE and --yes." >&2; exit 1 ;;
  esac
done

refuse() { echo "release: $1" >&2; exit 1; }

if [ -n "$notes" ] && [ ! -f "$notes" ]; then
  refuse "the notes file $notes does not exist. Write it first, or leave --notes-file out to let GitHub write the notes."
fi

cd "$ROOT"
version="$(/usr/bin/plutil -extract version raw -o - package.json 2>/dev/null || true)"
# The app compares versions as three numbers, and the tag and every asset name are built from this.
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "package.json's version \"$version\" is not three numbers like 1.2.3."
tag="v$version"

# --- refusals, before anything is built ------------------------------------------------------------
# A release must be exactly a commit, so a tree with changes in it could publish code nobody can find.
if [ -n "$(git status --porcelain)" ]; then
  refuse "the working tree has uncommitted changes. Commit or remove them, so the release is exactly what $tag will point at."
fi
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  refuse "the tag $tag already exists here. Bump the version in package.json; a published version is never rebuilt."
fi
# ls-remote --exit-code: 0 means the tag is there, 2 means it is not, anything else means no answer.
remote_rc=0
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 || remote_rc=$?
case "$remote_rc" in
  0) refuse "the tag $tag already exists on GitHub. Bump the version in package.json; a published version is never rebuilt." ;;
  2) ;;
  *) refuse "could not ask origin whether $tag exists (git ls-remote exited $remote_rc). Check the network and try again." ;;
esac
# Without -v: the identity is self-signed and untrusted, so `find-identity -v` never lists it, and
# codesign signs with it all the same (spec §10).
# Read whole before searching: `grep -q` stops at the first match, and under pipefail the writer it
# cut off would turn a found identity into a refusal.
identities="$(security find-identity -p codesigning 2>/dev/null || true)"
if ! grep -qF "\"$IDENTITY\"" <<<"$identities"; then
  refuse "the signing identity \"$IDENTITY\" is not in this Mac's keychain. Release from the Mac that has it; scripts/app/make-signing-cert.sh made it there."
fi
if ! gh auth status >/dev/null 2>&1; then
  refuse "gh is not logged into GitHub. Run gh auth login, then try again."
fi

head_before="$(git rev-parse HEAD)"

# --- build and check -------------------------------------------------------------------------------
if ! bash "$ROOT/scripts/app/build-release.sh"; then
  refuse "the build or one of its checks failed (see above), so nothing was published."
fi

# The build must not have changed what the tag will point at.
if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$head_before" ]; then
  refuse "the tree changed while building, so nothing was published. Look at git status, then start again."
fi

assets=(
  "release/Parcels-$version-arm64.zip"
  "release/Parcels-$version-x64.zip"
  "release/Parcels-$version-arm64.dmg"
  "release/Parcels-$version-x64.dmg"
  "release/SHA256SUMS"
)
for a in "${assets[@]}"; do
  [ -f "$a" ] || refuse "the build did not produce $a, so nothing was published."
done

echo
echo "Ready to publish $tag to $REPO_SLUG with these assets:"
for a in "${assets[@]}"; do
  printf '  %s  (%s bytes)\n' "$a" "$(stat -f %z "$a")"
done
echo

if [ "$yes" != 1 ]; then
  printf 'Publish %s to GitHub? [y/N] ' "$tag"
  answer=""
  # No terminal (stdin closed or /dev/null) reads as "no".
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo; echo "release: nothing was published. The checked build is in release/." >&2; exit 1 ;;
  esac
fi

# --- publish ------------------------------------------------------------------------------------------
notes_args=(--generate-notes)
[ -z "$notes" ] || notes_args=(--notes-file "$notes")

# The prompt can wait a long time; a build in another pane must not have swapped the zips meanwhile.
(cd release && shasum -a 256 -c -s SHA256SUMS) \
  || refuse "release/ changed after it was checked. Run the release again."

git tag "$tag"
trap 'echo "release: publishing stopped partway. If $tag never reached GitHub, remove it with: git tag -d $tag. If it did, finish with: gh release create $tag ${assets[*]} --repo $REPO_SLUG --verify-tag" >&2' ERR
git push origin "$tag"
# --verify-tag: the release is made only from the tag just pushed, never from a tag gh would create.
gh release create "$tag" "${assets[@]}" --repo "$REPO_SLUG" --title "Parcels $version" --verify-tag "${notes_args[@]}"
echo "Published $tag: https://github.com/$REPO_SLUG/releases/tag/$tag"
