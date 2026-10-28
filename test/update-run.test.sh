#!/bin/bash
# Checks the two halves of "update this app without a terminal" that are shell:
#
#   scripts/update.sh --check --porcelain   the machine-readable check the Update section parses
#   scripts/update-run.sh                   the wrapper the dashboard spawns detached, which records
#                                           what happened and puts the checkout back if it broke
#
# Everything happens in a temp directory. Nothing touches the network, launchd, npm, the real
# config.json or this repository's branch and remote: the only thing done to $ROOT is a `git clone
# --bare --no-hardlinks` out of it, which is read-only, and every fetch afterwards is between two
# directories under $TMP. `npm ci` and `install-agents.sh` are never run - the wrapper's two
# documented seams (PARCELS_UPDATE_SCRIPT, PARCELS_UPDATE_REBUILD) point at stubs instead.
#
# Run directly, or via test/update-run.test.ts under vitest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $d"; else echo "FAIL $d"; fail=1; fi
}

UPDATE="$ROOT/scripts/update.sh"
RUN="$ROOT/scripts/update-run.sh"
LIB="$ROOT/scripts/lib/node.sh"

REAL_CONFIG_MTIME="$(stat -f %m%z "$ROOT/config.json" 2>/dev/null || echo none)"
REAL_STATUS_MTIME="$(stat -f %m%z "$ROOT/data/update-status.json" 2>/dev/null || echo none)"

# --- the wrapper is a script, and it is the one allowed to reach for launchd -------------------------
check "update-run.sh parses"                         bash -n "$RUN"
check "update-run.sh is executable"                  test -x "$RUN"
# NOT set -e: every failure in the wrapper has to be recorded in the status file, not inherited.
check "update-run.sh does not inherit -e"            bash -c "! grep -q 'set -euo pipefail' '$RUN'"
check "update-run.sh is still strict about unset"    grep -q 'set -uo pipefail' "$RUN"
check "it delegates the update to update.sh"         grep -q 'PARCELS_UPDATE_SCRIPT' "$RUN"
check "its default updater is scripts/update.sh"     grep -qE 'PARCELS_UPDATE_SCRIPT:-.*scripts/update\.sh' "$RUN"
check "its default rebuild reinstalls the agents"    grep -q 'install-agents.sh' "$RUN"
check "it never calls launchctl itself"              bash -c "! grep -q 'launchctl' '$RUN'"
check "it rolls back to the commit it recorded"      grep -qE 'reset --hard "\$BEFORE"' "$RUN"
check "it only resets when HEAD actually moved"      grep -qE '\[ "\$AFTER" (=|!=) "\$BEFORE" \]' "$RUN"
check "it writes its status atomically"              grep -qE 'mv -f "\$tmp"' "$RUN"
check "update.sh gained a porcelain mode"            grep -q -- '--porcelain' "$UPDATE"
check "porcelain implies --check, so it cannot install" \
  bash -c "grep -A2 -- '--porcelain)' '$UPDATE' | grep -q 'check_only=1'"

# --- a throwaway origin, and clones of it -----------------------------------------------------------
# The bare clone is the only thing taken out of $ROOT, and it is read-only. Everything below fetches
# between directories under $TMP.
BARE="$TMP/origin.git"
git clone --quiet --bare --no-hardlinks "$ROOT" "$BARE" 2>/dev/null || {
  echo "FAIL could not clone the repository into a temp directory"; exit 1
}

# install <dir> [commit]  -> a clone of the throwaway origin with the scripts under test committed
# into it, optionally rewound to <commit> so it is behind its upstream. The scripts may not be
# committed yet, so they are copied in and committed: identical files once they are, so the clone is
# clean either way, and a `git reset --hard` inside it keeps them.
install() {
  git clone --quiet --no-hardlinks "$BARE" "$1" 2>/dev/null || return 1
  mkdir -p "$1/scripts/lib"
  cp "$UPDATE" "$RUN" "$1/scripts/" && cp "$LIB" "$1/scripts/lib/" || return 1
  chmod +x "$1/scripts/update.sh" "$1/scripts/update-run.sh"
  local branch
  branch="$(git -C "$1" rev-parse --abbrev-ref HEAD)" || return 1
  if ! git -C "$1" diff --quiet; then
    git -C "$1" -c user.email=t@example.com -c user.name=t commit -qam "scripts under test" || return 1
    git -C "$1" push -q origin "HEAD:$branch" || return 1
  fi
  [ -z "${2:-}" ] || git -C "$1" reset --quiet --hard "$2" || return 1
}

FIRST="$TMP/first"
install "$FIRST" || { echo "FAIL could not prepare the first clone"; exit 1; }
BASE_HEAD="$(git -C "$FIRST" rev-parse HEAD)"

# --- update.sh --check --porcelain, on a checkout that is up to date --------------------------------
out="$("$FIRST/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "porcelain check succeeds on an up-to-date clone"  test "$status" = 0
check "and reports state current"                        bash -c "grep -qx 'state current' <<< \"\$1\"" _ "$out"
check "with the version it is running"                   bash -c "grep -qxE 'version [0-9]+\.[0-9]+\.[0-9]+' <<< \"\$1\"" _ "$out"
check "the branch, and the upstream it compared against" bash -c "grep -qE '^branch .' <<< \"\$1\" && grep -qE '^upstream origin/' <<< \"\$1\"" _ "$out"
check "and the local and remote commits, which are equal" \
  bash -c "l=\$(grep '^local ' <<< \"\$1\" | cut -d' ' -f2); r=\$(grep '^remote ' <<< \"\$1\" | cut -d' ' -f2); test -n \"\$l\" -a \"\$l\" = \"\$r\"" _ "$out"
check "it lists no commits to install"                   bash -c "! grep -q '^log ' <<< \"\$1\"" _ "$out"
check "it prints no prose for a parser to trip over"     bash -c "! grep -qiE 'at version|fetching|up to date|using node' <<< \"\$1\"" _ "$out"
check "it builds nothing"                                bash -c "! grep -qiE 'npm ci|building dist|bootstrapped' <<< \"\$1\"" _ "$out"
check "and leaves HEAD where it was"                     bash -c "test \"\$(git -C '$FIRST' rev-parse HEAD)\" = '$BASE_HEAD'"
check "the human --check still reads as English"         bash -c "'$FIRST/scripts/update.sh' --check | grep -qi 'up to date'"

# --- a newer version appears on the origin -----------------------------------------------------------
UP="$TMP/upstream"
git clone --quiet --no-hardlinks "$BARE" "$UP" 2>/dev/null || { echo "FAIL could not clone the upstream"; exit 1; }
UP_BRANCH="$(git -C "$UP" rev-parse --abbrev-ref HEAD)"
sed -i '' 's/"version": "[^"]*"/"version": "9.9.9"/' "$UP/package.json"
git -C "$UP" -c user.email=t@example.com -c user.name=t commit -qam "release 9.9.9, the newer version" \
  && git -C "$UP" push -q origin "HEAD:$UP_BRANCH" || { echo "FAIL could not publish an upstream commit"; exit 1; }
NEW_HEAD="$(git -C "$UP" rev-parse HEAD)"

out="$("$FIRST/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "porcelain check succeeds on a clone that is behind" test "$status" = 0
check "and reports state behind"                           bash -c "grep -qx 'state behind' <<< \"\$1\"" _ "$out"
check "with the number of commits"                         bash -c "grep -qx 'behind 1' <<< \"\$1\"" _ "$out"
check "and what changed, one line per commit"              bash -c "grep -q '^log .*release 9.9.9, the newer version' <<< \"\$1\"" _ "$out"
check "the remote commit it names is the new one"          bash -c "grep -qx 'remote $NEW_HEAD' <<< \"\$1\"" _ "$out"
check "a check does not install it"                        bash -c "test \"\$(git -C '$FIRST' rev-parse HEAD)\" = '$BASE_HEAD'"
check "the version is still the old one after a check"     bash -c "! grep -q '9.9.9' '$FIRST/package.json'"

# --- a refusal in porcelain mode is still a refusal --------------------------------------------------
PLAIN="$TMP/plain"
mkdir -p "$PLAIN"
cp -R "$ROOT/scripts" "$PLAIN/scripts"
cp "$ROOT/package.json" "$PLAIN/package.json"
out="$("$PLAIN/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "porcelain on a directory that is not a checkout fails" test "$status" != 0
check "and says so in a line a parser can read"               bash -c "grep -qx 'state blocked' <<< \"\$1\"" _ "$out"
check "with the reason on its own line"                       bash -c "grep -q '^reason .*not a git checkout' <<< \"\$1\"" _ "$out"

DIRTY="$TMP/dirty"
install "$DIRTY" || { echo "FAIL could not prepare the dirty clone"; exit 1; }
echo '# a local edit nobody asked to lose' >> "$DIRTY/README.md"
out="$("$DIRTY/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "porcelain on a dirty tree fails"                       test "$status" != 0
check "and is blocked, not reported as up to date"            bash -c "grep -qx 'state blocked' <<< \"\$1\"" _ "$out"
check "the local edit is still there"                         grep -q 'nobody asked to lose' "$DIRTY/README.md"
check "the reason names the file"                             bash -c "grep -qx 'reason the working tree has uncommitted changes (README.md), so nothing was updated.' <<< \"\$1\"" _ "$out"

# npm rewriting package-lock.json by itself (npm 12 adds "hasInstallScript") is not a local edit.
LOCK="$TMP/lock"
install "$LOCK" "$BASE_HEAD" || { echo "FAIL could not prepare the lock-file clone"; exit 1; }
sed -i '' 's/"lockfileVersion": 3,/"lockfileVersion": 3, "x-npm-rewrote-this": true,/' "$LOCK/package-lock.json"
out="$("$LOCK/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "package-lock.json changed alone does not block the check" test "$status" = 0
check "it reports the update instead"                            bash -c "grep -qx 'state behind' <<< \"\$1\"" _ "$out"
check "and a check leaves the lock file as npm left it"          grep -q 'x-npm-rewrote-this' "$LOCK/package-lock.json"

# ... but beside a changed package.json it is somebody changing the dependencies, and that is refused.
echo ' ' >> "$LOCK/package.json"
out="$("$LOCK/scripts/update.sh" --check --porcelain 2>/dev/null)"; status=$?
check "package-lock.json with package.json is refused"           test "$status" != 0
check "naming both files"                                        bash -c "grep -qx 'reason the working tree has uncommitted changes (package-lock.json, package.json), so nothing was updated.' <<< \"\$1\"" _ "$out"

# --- the wrapper: stubs for the updater and the rebuild ----------------------------------------------
# Both live OUTSIDE the clone, so a `git reset --hard` inside it cannot restore the real ones.
STUBS="$TMP/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/pull-then-fail.sh" <<'EOF'
#!/bin/bash
# A real update that pulls and then fails to build, without npm or the network.
git -C "$PWD" pull --ff-only --quiet || exit 1
echo "npm ERR! the build broke"
exit 1
EOF
cat > "$STUBS/refuse.sh" <<'EOF'
#!/bin/bash
echo "update: the working tree has uncommitted changes, so nothing was updated." >&2
exit 1
EOF
cat > "$STUBS/pull-then-ok.sh" <<'EOF'
#!/bin/bash
git -C "$PWD" pull --ff-only --quiet || exit 1
echo "== Updated"
EOF
cat > "$STUBS/rebuild.sh" <<'EOF'
#!/bin/bash
echo "rebuild stub ran" >> "$PARCELS_REBUILD_MARK"
EOF
cat > "$STUBS/rebuild-fails.sh" <<'EOF'
#!/bin/bash
echo "rebuild stub failed" >> "$PARCELS_REBUILD_MARK"
exit 1
EOF
chmod +x "$STUBS"/*.sh

STARTED=2026-10-28T09:00:00.000Z
wrapper() { # wrapper <clone> <updater stub> <rebuild stub> <status file> <mark file>
  ( cd "$1" && PARCELS_UPDATE_SCRIPT="$2" PARCELS_UPDATE_REBUILD="$3" \
      PARCELS_UPDATE_STATUS="$4" PARCELS_UPDATE_STARTED="$STARTED" \
      PARCELS_REBUILD_MARK="$5" "$1/scripts/update-run.sh" )
}
field() { # field <status file> <key>  -> the JSON string or number value, or empty
  grep -oE "\"$2\":\"?[^\",}]*" "$1" | head -1 | sed -E "s/\"$2\":\"?//"
}
# The checks below run their command through `bash -c`, which is a fresh shell.
export -f field

# A failed build: HEAD moved, so the checkout has to go back and be rebuilt.
BROKE="$TMP/broke"
install "$BROKE" "$BASE_HEAD" || { echo "FAIL could not prepare the broken-build clone"; exit 1; }
wrapper "$BROKE" "$STUBS/pull-then-fail.sh" "$STUBS/rebuild.sh" "$TMP/broke.json" "$TMP/broke.mark" >/dev/null 2>&1
broke_status=$?

check "a failed update exits non-zero"                  test "$broke_status" != 0
check "it rolls the checkout back to where it started"  bash -c "test \"\$(git -C '$BROKE' rev-parse HEAD)\" = '$BASE_HEAD'"
check "so the version afterwards is the old one"        bash -c "! grep -q '9.9.9' '$BROKE/package.json'"
check "and the rollback rebuilt, so the machine runs something" test -s "$TMP/broke.mark"
check "the status file says the update failed"          bash -c "test \"\$(field '$TMP/broke.json' state)\" = failed"
check "and that it was rolled back"                     bash -c "test \"\$(field '$TMP/broke.json' rollback)\" = ok"
check "it records the commit it went back to"           bash -c "test \"\$(field '$TMP/broke.json' from)\" = '$BASE_HEAD'"
check "and the commit it is on now, which is the same"  bash -c "test \"\$(field '$TMP/broke.json' to)\" = '$BASE_HEAD'"
check "it keeps the start time it was given"            bash -c "test \"\$(field '$TMP/broke.json' startedAt)\" = '$STARTED'"
check "and says when it finished"                       grep -q 'finishedAt' "$TMP/broke.json"
check "it records update.sh's exit status"              bash -c "test \"\$(field '$TMP/broke.json' exit)\" = 1"
check "the tree is clean after the rollback"            bash -c "test -z \"\$(git -C '$BROKE' status --porcelain --untracked-files=no)\""

# A refusal: HEAD never moved, so there is nothing to roll back - and a `git reset --hard` here would
# eat the very local edit the update was refused for.
REFUSED="$TMP/refused"
install "$REFUSED" "$BASE_HEAD" || { echo "FAIL could not prepare the refused clone"; exit 1; }
echo '# a local edit nobody asked to lose' >> "$REFUSED/README.md"
wrapper "$REFUSED" "$STUBS/refuse.sh" "$STUBS/rebuild.sh" "$TMP/refused.json" "$TMP/refused.mark" >/dev/null 2>&1
refused_status=$?

check "a refused update exits non-zero"                 test "$refused_status" != 0
check "it is recorded as failed"                        bash -c "test \"\$(field '$TMP/refused.json' state)\" = failed"
check "with no rollback, because nothing was installed" bash -c "test \"\$(field '$TMP/refused.json' rollback)\" = none"
check "HEAD was not touched"                            bash -c "test \"\$(git -C '$REFUSED' rev-parse HEAD)\" = '$BASE_HEAD'"
check "and the local edit it was refused for survives"  grep -q 'nobody asked to lose' "$REFUSED/README.md"
check "nothing was rebuilt either"                      bash -c "test ! -e '$TMP/refused.mark'"

# A rollback that itself fails is the one that needs a person, and it must say so.
STUCK="$TMP/stuck"
install "$STUCK" "$BASE_HEAD" || { echo "FAIL could not prepare the stuck clone"; exit 1; }
wrapper "$STUCK" "$STUBS/pull-then-fail.sh" "$STUBS/rebuild-fails.sh" "$TMP/stuck.json" "$TMP/stuck.mark" >/dev/null 2>&1
stuck_status=$?
check "a rollback that cannot rebuild exits non-zero"      test "$stuck_status" != 0
check "it is recorded as failed"                           bash -c "test \"\$(field '$TMP/stuck.json' state)\" = failed"
check "and the rollback is recorded as failed, not as ok"  bash -c "test \"\$(field '$TMP/stuck.json' rollback)\" = failed"
check "the checkout was still put back to the old commit"  bash -c "test \"\$(git -C '$STUCK' rev-parse HEAD)\" = '$BASE_HEAD'"

# The happy path.
GOOD="$TMP/good"
install "$GOOD" "$BASE_HEAD" || { echo "FAIL could not prepare the good clone"; exit 1; }
wrapper "$GOOD" "$STUBS/pull-then-ok.sh" "$STUBS/rebuild.sh" "$TMP/good.json" "$TMP/good.mark" >/dev/null 2>&1
good_status=$?

check "a successful update exits 0"                     test "$good_status" = 0
check "it is recorded as ok"                            bash -c "test \"\$(field '$TMP/good.json' state)\" = ok"
check "it moved to the new commit"                      bash -c "test \"\$(field '$TMP/good.json' to)\" = '$NEW_HEAD'"
check "from the one it was on"                           bash -c "test \"\$(field '$TMP/good.json' from)\" = '$BASE_HEAD'"
check "the checkout really is on the new version"       grep -q '9.9.9' "$GOOD/package.json"
check "it did not roll anything back"                   bash -c "! grep -q '\"rollback\":\"ok\"' '$TMP/good.json'"
check "and it did not run the rollback rebuild"         bash -c "test ! -e '$TMP/good.mark'"

# The log is the only account of what an update did: its parent does not live to see the end of it.
out="$(wrapper "$GOOD" "$STUBS/pull-then-ok.sh" "$STUBS/rebuild.sh" "$TMP/again.json" "$TMP/again.mark" 2>&1)"
check "the wrapper narrates what it is doing on stdout" bash -c "grep -qi 'update' <<< \"\$1\"" _ "$out"
check "and names the commit it started from"            bash -c "grep -qE 'at [0-9a-f]{40}' <<< \"\$1\"" _ "$out"

# --- nothing escaped into the real installation ------------------------------------------------------
check "the real config.json was not touched"            test "$REAL_CONFIG_MTIME" = "$(stat -f %m%z "$ROOT/config.json" 2>/dev/null || echo none)"
check "the real update status file was not written"     test "$REAL_STATUS_MTIME" = "$(stat -f %m%z "$ROOT/data/update-status.json" 2>/dev/null || echo none)"
check "no launchd agent was written during this test"   bash -c "test -z \"\$(find '$TMP' -name '*.plist' 2>/dev/null)\""

exit $fail
