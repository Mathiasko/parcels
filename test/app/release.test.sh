#!/bin/bash
# Checks scripts/app/release.sh's refusals, and that it publishes only when told to, without ever
# building, signing or publishing anything for real.
#
# The script runs from a throwaway copy of the repository under $TMP: release.sh, package.json and the
# certificate hash are copied in, and scripts/app/build-release.sh there is a stub that only writes
# empty artifacts, so the real build (npm ci, electron-builder, codesign) never runs. `git`, `gh` and
# `security` are stubs first on PATH. Each records its arguments in $TMP/calls.log, and the test reads
# that log to prove that no refusal reaches `gh release` or `git tag`.
#
# Run directly, or via test/app/release.test.ts under vitest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $d"; else echo "FAIL $d"; fail=1; fi
}

RELEASE="$ROOT/scripts/app/release.sh"
check "release.sh parses"        bash -n "$RELEASE"
check "release.sh is executable" test -x "$RELEASE"

VERSION="$(/usr/bin/plutil -extract version raw -o - "$ROOT/package.json")"
TAG="v$VERSION"

# --- the throwaway repository ---------------------------------------------------------------------
REPO="$TMP/repo"
mkdir -p "$REPO/scripts/app" "$REPO/app"
cp "$RELEASE" "$REPO/scripts/app/release.sh"
cp "$ROOT/package.json" "$REPO/package.json"
cp "$ROOT/app/signing-cert.sha256" "$REPO/app/signing-cert.sha256"
# The stub build writes the five assets the real one would, as empty files, and records that it ran.
cat > "$REPO/scripts/app/build-release.sh" <<'EOF'
#!/bin/bash
echo "build-release $*" >> "$CALLS"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
v="$(/usr/bin/plutil -extract version raw -o - "$ROOT/package.json")"
mkdir -p "$ROOT/release"
for f in "Parcels-$v-arm64.zip" "Parcels-$v-x64.zip" "Parcels-$v-arm64.dmg" "Parcels-$v-x64.dmg" SHA256SUMS; do
  : > "$ROOT/release/$f"
done
[ -z "${STUB_BUILD_FAILS:-}" ] || exit 1
EOF
chmod +x "$REPO/scripts/app/build-release.sh"
echo "What changed." > "$TMP/notes.md"

# --- the stubs --------------------------------------------------------------------------------------
# Each stub's behaviour is chosen by an environment variable, so one stub serves every case.
BIN="$TMP/bin"
mkdir -p "$BIN"
cat > "$BIN/git" <<'EOF'
#!/bin/bash
echo "git $*" >> "$CALLS"
case "$1" in
  status) [ -n "${STUB_DIRTY:-}" ] && echo " M src/web/server.ts"; exit 0 ;;
  rev-parse)
    case "$*" in
      *refs/tags/*) [ -n "${STUB_LOCAL_TAG:-}" ] && { echo 0123456789abcdef; exit 0; }; exit 1 ;;
      *) echo 0123456789abcdef0123456789abcdef01234567; exit 0 ;;
    esac ;;
  ls-remote)
    [ -n "${STUB_REMOTE_DOWN:-}" ] && exit 128
    [ -n "${STUB_REMOTE_TAG:-}" ] && { echo "0123456789abcdef	refs/tags/$STUB_REMOTE_TAG"; exit 0; }
    exit 2 ;;
  tag|push) exit 0 ;;
esac
exit 0
EOF
cat > "$BIN/gh" <<'EOF'
#!/bin/bash
echo "gh $*" >> "$CALLS"
case "$1" in
  auth) [ -n "${STUB_NO_GH_AUTH:-}" ] && { echo "You are not logged into any GitHub hosts." >&2; exit 1; }; exit 0 ;;
esac
exit 0
EOF
cat > "$BIN/security" <<'EOF'
#!/bin/bash
echo "security $*" >> "$CALLS"
echo "Policy: Code Signing"
echo "  Matching identities"
if [ -z "${STUB_NO_IDENTITY:-}" ]; then
  echo '  1) 0EF12A68FBC4EBFD638746B5678372BAC73D8DDC "Parcels Signing" (CSSMERR_TP_NOT_TRUSTED)'
  echo "     1 identities found"
else
  echo '  1) 1111111111111111111111111111111111111111 "Someone Else" (CSSMERR_TP_NOT_TRUSTED)'
  echo "     1 identities found"
fi
echo ""
echo "  Valid identities only"
echo "     0 valid identities found"
EOF
chmod +x "$BIN/git" "$BIN/gh" "$BIN/security"

# run <name> [env assignments...] -- [release.sh args...]  ->  $TMP/<name>.out (stdout and stderr),
# $TMP/<name>.calls (what the stubs saw), and $TMP/<name>.rc. Stdin is /dev/null: a prompt reads "no".
run() {
  local name="$1"; shift
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  rm -rf "$REPO/release"
  : > "$TMP/$name.calls"
  env PATH="$BIN:/usr/bin:/bin" CALLS="$TMP/$name.calls" "${envs[@]+"${envs[@]}"}" \
    bash "$REPO/scripts/app/release.sh" "$@" > "$TMP/$name.out" 2>&1 < /dev/null
  echo "$?" > "$TMP/$name.rc"
}
failed()      { [ "$(cat "$TMP/$1.rc")" != 0 ]; }
says()        { grep -qi -- "$2" "$TMP/$1.out"; }
called()      { grep -q -- "$2" "$TMP/$1.calls"; }
not_called()  { ! grep -q -- "$2" "$TMP/$1.calls"; }

# --- refusals -----------------------------------------------------------------------------------------
run dirty STUB_DIRTY=1 -- --notes-file "$TMP/notes.md"
check "a dirty tree is refused"                       failed dirty
check "  with a sentence naming uncommitted changes"  says dirty "uncommitted changes"
check "  before anything is built"                    not_called dirty "build-release"
check "  and nothing calls gh release"                not_called dirty "gh release"
check "  or git tag"                                  not_called dirty "git tag"

run localtag STUB_LOCAL_TAG=1 -- --notes-file "$TMP/notes.md"
check "an existing local tag is refused"              failed localtag
check "  with a sentence naming the tag"              says localtag "$TAG already exists"
check "  before anything is built"                    not_called localtag "build-release"
check "  and nothing calls gh release"                not_called localtag "gh release"

run remotetag "STUB_REMOTE_TAG=$TAG" -- --notes-file "$TMP/notes.md"
check "a tag that exists only on GitHub is refused"   failed remotetag
check "  with a sentence naming the tag"              says remotetag "$TAG already exists"
check "  and nothing calls gh release"                not_called remotetag "gh release"

run remotedown STUB_REMOTE_DOWN=1 -- --notes-file "$TMP/notes.md"
check "an unreachable origin is refused"              failed remotedown
check "  with a sentence saying so"                   says remotedown "could not ask origin"
check "  and nothing calls gh release"                not_called remotedown "gh release"

run noidentity STUB_NO_IDENTITY=1 -- --notes-file "$TMP/notes.md"
check "a missing signing identity is refused"         failed noidentity
check "  with a sentence naming the identity"         says noidentity '"Parcels Signing" is not in'
check "  before anything is built"                    not_called noidentity "build-release"
check "  and nothing calls gh release"                not_called noidentity "gh release"

run noauth STUB_NO_GH_AUTH=1 -- --notes-file "$TMP/notes.md"
check "a missing gh login is refused"                 failed noauth
check "  with a sentence saying how to log in"        says noauth "gh auth login"
check "  before anything is built"                    not_called noauth "build-release"
check "  and nothing calls gh release"                not_called noauth "gh release"

run nonotes -- --notes-file "$TMP/missing.md"
check "a notes file that does not exist is refused"   failed nonotes
check "  with a sentence naming it"                   says nonotes "missing.md"
check "  before anything is built"                    not_called nonotes "build-release"

run badarg -- --publish
check "an unknown option is refused"                  failed badarg
check "  with a sentence naming it"                   says badarg "--publish"
check "  before anything is built"                    not_called badarg "build-release"

run buildfails STUB_BUILD_FAILS=1 -- --notes-file "$TMP/notes.md" --yes
check "a failed build is not published, even with --yes" failed buildfails
check "  and says nothing was published"              says buildfails "nothing was published"
check "  and nothing calls gh release"                not_called buildfails "gh release"
check "  or git tag"                                  not_called buildfails "git tag"

# Every refusal, whatever stopped it: nothing tagged, pushed or released.
for r in dirty localtag remotetag remotedown noidentity noauth nonotes badarg buildfails; do
  check "$r: no git tag, git push or gh release" \
    bash -c "! grep -qE '^(git tag|git push|gh release)' '$TMP/$r.calls'"
done

# --- the prompt -----------------------------------------------------------------------------------------
run declined -- --notes-file "$TMP/notes.md"
check "without --yes it asks before publishing"       says declined "Publish $TAG to GitHub? \[y/N\]"
check "  it lists the assets first"                   says declined "Parcels-$VERSION-arm64.dmg"
check "  no answer means no"                          failed declined
check "  and says nothing was published"              says declined "nothing was published"
check "  the build did run"                           called declined "build-release"
check "  but nothing calls gh release"                not_called declined "gh release"
check "  or git tag"                                  not_called declined "git tag"
check "  or git push"                                 not_called declined "git push"

# --- publishing, with stubs ------------------------------------------------------------------------------
run yes -- --notes-file "$TMP/notes.md" --yes
check "--yes publishes"                               bash -c "[ \"\$(cat '$TMP/yes.rc')\" = 0 ]"
check "  it tags $TAG"                                called yes "git tag $TAG"
check "  pushes only that tag to origin"              called yes "git push origin $TAG"
check "  and creates the release with all five assets" \
  grep -qE "gh release create $TAG .*release/Parcels-$VERSION-arm64.zip .*release/Parcels-$VERSION-x64.zip .*release/Parcels-$VERSION-arm64.dmg .*release/Parcels-$VERSION-x64.dmg .*release/SHA256SUMS" "$TMP/yes.calls"
check "  on Mathiasko/parcels"                        called yes "--repo Mathiasko/parcels"
check "  with the notes file"                         called yes "--notes-file $TMP/notes.md"
check "  tagging only after the build"                bash -c "grep -n 'build-release\|git tag' '$TMP/yes.calls' | head -1 | grep -q build-release"

exit "$fail"
