#!/bin/bash
# Checks scripts/setup.sh, scripts/update.sh and the node library they share with install-agents.sh.
# Everything happens in a temp directory: no real config.json, no launchd, no network, and the real
# repository's branch and remote are never touched - update.sh is exercised against a throwaway
# clone whose origin is this directory on disk. Run directly, or via test/setup.test.ts under vitest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $d"; else echo "FAIL $d"; fail=1; fi
}

# The real config.json must come out of this byte-for-byte untouched; its mtime and size are the proof.
REAL_CONFIG_MTIME="$(stat -f %m%z "$ROOT/config.json" 2>/dev/null || echo none)"

SETUP="$ROOT/scripts/setup.sh"
UPDATE="$ROOT/scripts/update.sh"
LIB="$ROOT/scripts/lib/node.sh"
INSTALL="$ROOT/scripts/install-agents.sh"
# The wrapper the dashboard's Update button spawns. Its own behaviour is checked by
# test/update-run.test.sh; here it only has to obey the same house rules as the other scripts.
RUNSH="$ROOT/scripts/update-run.sh"

# --- the scripts are scripts -------------------------------------------------------------------------
check "setup.sh parses"                              bash -n "$SETUP"
check "update.sh parses"                             bash -n "$UPDATE"
check "lib/node.sh parses"                           bash -n "$LIB"
check "setup.sh is executable"                       test -x "$SETUP"
check "update.sh is executable"                      test -x "$UPDATE"
check "both are strict (set -euo pipefail)"          bash -c "for f in '$SETUP' '$UPDATE'; do grep -q 'set -euo pipefail' \"\$f\" || exit 1; done"
check "no script runs sudo itself"                   bash -c "! grep -nE '^[^#]*\bsudo\b' '$SETUP' '$UPDATE' '$RUNSH' | grep -qv install-hostname"

# --- the node logic is shared, not copied ------------------------------------------------------------
# The whole point of scripts/lib/node.sh: install-agents.sh bakes the chosen node into the launchd
# plists while setup.sh and update.sh run npm with it, so if these ever disagreed the agents would run
# a different Node from the one that installed the dependencies.
check "lib/node.sh defines find_node"                grep -q '^find_node()' "$LIB"
check "lib/node.sh defines require_node"             grep -q '^require_node()' "$LIB"
check "lib/node.sh owns MIN_NODE_MAJOR"              bash -c "test \"\$(grep -l 'MIN_NODE_MAJOR=' '$LIB' '$SETUP' '$UPDATE' '$INSTALL' '$RUNSH' 2>/dev/null | wc -l | tr -d ' ')\" = 1"
check "setup.sh sources lib/node.sh"                 grep -qE '^\. .*lib/node\.sh' "$SETUP"
check "update.sh sources lib/node.sh"                grep -qE '^\. .*lib/node\.sh' "$UPDATE"
check "install-agents.sh sources lib/node.sh"        grep -qE '^\. .*lib/node\.sh' "$INSTALL"
# update-run.sh sources it inside its rollback, which is the only place it needs npm.
check "update-run.sh sources lib/node.sh"            grep -qE '^ *\. .*lib/node\.sh' "$RUNSH"
check "no script redefines find_node"                bash -c "! grep -l '^find_node()' '$SETUP' '$UPDATE' '$INSTALL' '$RUNSH'"
check "no script re-implements the nvm search"       bash -c "! grep -l 'nvm/versions/node' '$SETUP' '$UPDATE' '$INSTALL' '$RUNSH'"
check "each sourcing script calls require_node"      bash -c "for f in '$SETUP' '$UPDATE' '$INSTALL' '$RUNSH'; do grep -qE '^ *require_node ' \"\$f\" || exit 1; done"

# --- setup.sh and config.json ------------------------------------------------------------------------
# --config-only stops before `npm install` and before launchd, so nothing here installs or loads
# anything. PARCELS_CONFIG keeps every write inside the temp directory.
run_setup() { PARCELS_CONFIG="$1" PARCELS_POSTCODE="${2-}" "$SETUP" --config-only </dev/null; }

EXISTING="$TMP/existing.json"
printf '{"defaultPostalCode":"99999","dbPath":"data/mine.db","imap":{"host":"h","port":993,"user":"u","pass":"SECRET","mailbox":"parcels"}}\n' > "$EXISTING"
BEFORE="$(cat "$EXISTING")"
out="$(run_setup "$EXISTING" 85101 2>&1)"; existing_status=$?

check "setup.sh succeeds when config.json already exists"  test "$existing_status" = 0
check "setup.sh does not overwrite an existing config.json" test "$(cat "$EXISTING")" = "$BEFORE"
check "setup.sh says it is keeping the existing file"      bash -c "grep -qi 'keeping it' <<< \"\$1\"" _ "$out"
check "setup.sh did not leak the stored password"          bash -c "! grep -q SECRET <<< \"\$1\"" _ "$out"
check "setup.sh did not prompt for a postcode"             bash -c "! grep -qi 'your postcode' <<< \"\$1\"" _ "$out"
check "--config-only does not install or load anything"    bash -c "! grep -qiE 'npm install|bootstrapped|building dist' <<< \"\$1\"" _ "$out"

FRESH="$TMP/fresh.json"
run_setup "$FRESH" 85101 >/dev/null 2>&1
check "setup.sh creates config.json when it is absent"     test -f "$FRESH"
check "the new config.json is mode 600"                    test "$(stat -f %Lp "$FRESH" 2>/dev/null)" = 600
check "it records the postcode that was given"             grep -q '"defaultPostalCode": "85101"' "$FRESH"
# No imap block: that is the "no mail account configured" state, which /settings fills in with a
# password it can immediately test. A setup script can only store a credential and hope.
check "it writes no imap block, and no placeholder secret" bash -c "! grep -qE 'imap|app-password' '$FRESH'"
check "setup.sh never reads a credential"                  bash -c "! grep -nE 'read( -r)?' '$SETUP' | grep -qiE 'pass|secret|token|credential'"
check "setup.sh prompts for nothing but a postcode and y/n" bash -c "! grep -nE '^[^#]*read -r' '$SETUP' | grep -qvE 'postcode|answer'"
check "setup.sh points at /settings for the mail set-up"   grep -q '/settings' "$SETUP"

# What it may install, and what it must only ever suggest. Homebrew creates /opt/homebrew, edits a
# shell profile and asks for sudo; a script someone got from a friend must not do that unprompted.
check "setup.sh never executes the Homebrew installer"    bash -c "! grep -nE 'install\.sh' '$SETUP' | grep -qvE '^[0-9]+: *(#|echo)'"
check "setup.sh never curl-pipes anything into a shell"   bash -c "! grep -nE 'curl[^|]*\|[[:space:]]*(ba)?sh' '$SETUP' | grep -qvE '^[0-9]+: *(#|echo)'"
check "setup.sh offers Node only via brew install"        grep -q 'brew install node' "$SETUP"
check "setup.sh offers terminal-notifier"                 grep -q 'terminal-notifier' "$SETUP"
check "setup.sh says how to get git when it is absent"    grep -q 'xcode-select --install' "$SETUP"
check "a missing optional never stops the run"            bash -c "! grep -nE 'exit 1' '$SETUP' | grep -qiE 'terminal-notifier|git '"

# The closing instructions name the port the config actually has, everywhere a URL is printed.
PORTED="$TMP/ported.json"
printf '{"defaultPostalCode":"85101","port":9123,"imap":{"host":"h","port":993,"user":"u","pass":"p","mailbox":"parcels"}}\n' > "$PORTED"
out="$(run_setup "$PORTED" 2>&1)"
check "the closing message uses the configured port"      bash -c "grep -q '127.0.0.1:9123' <<< \"\$1\"" _ "$out"
check "the parcels.local URL uses it too"                 bash -c "grep -q 'parcels.local:9123' <<< \"\$1\"" _ "$out"
check "no URL in the closing message says 8787"           bash -c "! grep -qE ':8787' <<< \"\$1\"" _ "$out"

BAD="$TMP/bad.json"
check "setup.sh refuses a postcode that is not five digits" bash -c "! PARCELS_CONFIG='$BAD' PARCELS_POSTCODE=not-a-code '$SETUP' --config-only </dev/null"
check "and writes nothing when it refuses"                  test ! -e "$BAD"
NOTTY="$TMP/notty.json"
check "setup.sh with no terminal and no postcode stops"     bash -c "! PARCELS_CONFIG='$NOTTY' '$SETUP' --config-only </dev/null"
check "and writes nothing then either"                      test ! -e "$NOTTY"
check "setup.sh rejects an unknown flag"                    bash -c "! '$SETUP' --wat </dev/null"

# --- node discovery: one bad candidate must not strand the machine -----------------------------------
# A toolchain (Codex, an Electron app) can put a private node first on PATH with no npm beside it.
# Taking that one and giving up stranded a real user whose Mac had a perfectly good Node elsewhere.
NODEDIR="$TMP/nodes"
mkdir -p "$NODEDIR/nonpm" "$NODEDIR/old" "$NODEDIR/good"
printf '#!/bin/sh\necho 26\n' > "$NODEDIR/nonpm/node"      # usable version, but no npm sibling
printf '#!/bin/sh\necho 18\n' > "$NODEDIR/old/node"        # too old
printf '#!/bin/sh\necho 26\n' > "$NODEDIR/good/node"
printf '#!/bin/sh\nexit 0\n'  > "$NODEDIR/good/npm"
printf '#!/bin/sh\nexit 0\n'  > "$NODEDIR/old/npm"
chmod +x "$NODEDIR"/*/node "$NODEDIR/good/npm" "$NODEDIR/old/npm"

probe() { # probe <candidates...>  -> runs require_node against exactly these
  local list="" c
  for c in "$@"; do list="$list$c\n"; done
  bash -c ". '$LIB'; node_candidates() { printf '$list'; }; require_node probe" 2>&1
}

check "a node with no npm beside it is rejected"          bash -c "[ \"\$(. '$LIB'; node_rejection '$NODEDIR/nonpm/node')\" = 'no npm beside it' ]"
check "a too-old node is rejected by version"             bash -c ". '$LIB'; node_rejection '$NODEDIR/old/node' | grep -q 'need 24 or newer'"
check "a complete node is not rejected"                   bash -c "[ -z \"\$(. '$LIB'; node_rejection '$NODEDIR/good/node')\" ]"
check "discovery skips a bad candidate for a good one"    bash -c "probe() { bash -c \". '$LIB'; node_candidates() { printf '$NODEDIR/nonpm/node\\n$NODEDIR/good/node\\n'; }; require_node probe\"; }; probe | grep -q '$NODEDIR/good/node'"
check "with nothing usable it says so"                    bash -c "bash -c \". '$LIB'; node_candidates() { printf '$NODEDIR/nonpm/node\\n'; }; require_node probe\" 2>&1 | grep -q 'no usable Node'"
check "and names every candidate it turned down"          bash -c "bash -c \". '$LIB'; node_candidates() { printf '$NODEDIR/nonpm/node\\n$NODEDIR/old/node\\n'; }; require_node probe\" 2>&1 | grep -q 'no npm beside it'"
check "and does not claim nothing was found"              bash -c "! bash -c \". '$LIB'; node_candidates() { printf '$NODEDIR/nonpm/node\\n'; }; require_node probe\" 2>&1 | grep -q 'no node binary found at all'"

# --- update.sh, against a throwaway clone ------------------------------------------------------------
# The clone's origin is this directory, so fetching is a local, read-only operation: no network, and
# nothing in this repository is modified. The scripts under test are copied in because they may not
# be committed yet; they are identical files once they are, so the tree stays clean either way.
clone() { # clone <dir>
  local bare="$TMP/$(basename "$1")-origin.git"
  git clone --quiet --bare --no-hardlinks "$ROOT" "$bare" 2>/dev/null || return 1
  git clone --quiet --no-hardlinks "$bare" "$1" 2>/dev/null || return 1
  mkdir -p "$1/scripts/lib"
  cp "$SETUP" "$UPDATE" "$1/scripts/" && cp "$LIB" "$1/scripts/lib/" || return 1
  # The scripts under test may not be committed yet. Commit them here and push to this throwaway
  # origin, so the clone is both clean and current. Without this, editing any one of these three
  # scripts fails the up-to-date cases for a reason that has nothing to do with update.sh.
  if ! git -C "$1" diff --quiet; then
    git -C "$1" -c user.email=t@example.com -c user.name=t commit -qam "scripts under test" || return 1
    git -C "$1" push -q origin HEAD:main || return 1
  fi
}

CLEAN="$TMP/clean"
if clone "$CLEAN"; then
  CLEAN_HEAD="$(git -C "$CLEAN" rev-parse HEAD)"   # what the clone started at, not what ROOT is at
  out="$("$CLEAN/scripts/update.sh" --check 2>&1)"; check_status=$?
  check "update.sh --check succeeds on an up-to-date clone" test "$check_status" = 0
  check "update.sh --check says it is up to date"           bash -c "grep -qi 'up to date' <<< \"\$1\"" _ "$out"
  check "update.sh --check reports the version and commit"  bash -c "grep -qE 'at version [0-9]+\.[0-9]+\.[0-9]+ \([0-9a-f]{7,}\)' <<< \"\$1\"" _ "$out"
  check "update.sh --check builds nothing"                  bash -c "! grep -qiE 'npm ci|building dist|bootstrapped' <<< \"\$1\"" _ "$out"
  check "update.sh --check leaves the clone clean"          test -z "$(git -C "$CLEAN" status --porcelain --untracked-files=no)"
  check "update.sh --check leaves HEAD where it was"        test "$(git -C "$CLEAN" rev-parse HEAD)" = "$CLEAN_HEAD"

  # A dirty tree: the refusal must name the file, and must come before anything is fetched or built.
  echo '# a local edit nobody asked to lose' >> "$CLEAN/README.md"
  out="$("$CLEAN/scripts/update.sh" 2>&1)"; dirty_status=$?
  check "update.sh refuses to run on a dirty tree"         test "$dirty_status" != 0
  check "the refusal names the modified file"              bash -c "grep -q 'README.md' <<< \"\$1\"" _ "$out"
  check "the refusal says nothing was updated"             bash -c "grep -qi 'nothing was updated' <<< \"\$1\"" _ "$out"
  check "a dirty tree is refused before any npm or build"  bash -c "! grep -qiE 'npm ci|building dist|bootstrapped' <<< \"\$1\"" _ "$out"
  check "the local edit is still there afterwards"         grep -q 'nobody asked to lose' "$CLEAN/README.md"
  check "a dirty tree does not move HEAD"                  test "$(git -C "$CLEAN" rev-parse HEAD)" = "$CLEAN_HEAD"

  # A detached HEAD has no upstream: it must be named as such, not reported as a branch called HEAD.
  git -C "$CLEAN" checkout -q --detach HEAD
  out="$("$CLEAN/scripts/update.sh" --check 2>&1)"; detached_status=$?
  check "update.sh refuses a detached HEAD"                test "$detached_status" != 0
  check "and calls it a detached HEAD"                     bash -c "grep -qi 'detached HEAD' <<< \"\$1\"" _ "$out"
else
  echo "FAIL could not clone the repository into a temp directory"; fail=1
fi

# An unpacked tarball is not a checkout: it must be told so, not left with a confusing git error.
PLAIN="$TMP/plain"
mkdir -p "$PLAIN"
cp -R "$ROOT/scripts" "$PLAIN/scripts"
cp "$ROOT/package.json" "$PLAIN/package.json"
out="$("$PLAIN/scripts/update.sh" --check 2>&1)"; plain_status=$?
check "update.sh refuses a directory that is not a checkout" test "$plain_status" != 0
check "and explains that a tarball cannot be pulled"         bash -c "grep -qi 'not a git checkout' <<< \"\$1\"" _ "$out"

# --- update.sh can only fast-forward -----------------------------------------------------------------
check "update.sh pulls with --ff-only and nothing else"  bash -c "! grep -nE '^[^#]*git_? pull' '$UPDATE' | grep -qv -- '--ff-only'"
check "update.sh never merges or rebases"                bash -c "! grep -nE '^[[:space:]]*git_? (merge|rebase|reset|checkout|clean)' '$UPDATE'"
check "update.sh refuses a divergent branch"             grep -q 'diverged' "$UPDATE"
check "update.sh uses npm ci, not npm install"           bash -c "grep -qE '^[^#]*run_npm .* ci' '$UPDATE' && ! grep -qE '^[^#]*run_npm .* install' '$UPDATE'"
check "update.sh reinstalls the agents after pulling"    bash -c "p=\$(grep -n 'git_ pull' '$UPDATE' | grep -v '^[0-9]*:#' | head -1 | cut -d: -f1); a=\$(grep -n 'install-agents.sh\"' '$UPDATE' | tail -1 | cut -d: -f1); test -n \"\$p\" -a -n \"\$a\" -a \"\$p\" -lt \"\$a\""
check "update.sh rejects an unknown flag"                bash -c "! '$UPDATE' --wat"

# --- nothing escaped into the real installation ------------------------------------------------------
check "the real config.json was not touched"             test "$REAL_CONFIG_MTIME" = "$(stat -f %m%z "$ROOT/config.json" 2>/dev/null || echo none)"
check "no launchd agent was written during this test"    bash -c "test -z \"\$(find '$TMP' -name '*.plist' 2>/dev/null)\""

exit $fail
