#!/bin/bash
# Updates an installed copy: fast-forward the checkout, reinstall dependencies, rebuild, reload the
# launchd agents. Prints the version and commit before and after.
#
#   scripts/update.sh                       update, if there is anything to update
#   scripts/update.sh --check               say whether an update is available, and change nothing else
#   scripts/update.sh --check --porcelain   the same answer as `key value` lines, for the Update
#                                           section on /health (parsed by src/core/update.ts)
#
# Safe by default, which here means four refusals rather than four guesses:
#
#   - a dirty working tree      -> stop, and name the files. An update must never be the thing that
#                                  eats a local edit, and `git pull` into a dirty tree either fails
#                                  halfway or quietly merges. The one exception is package-lock.json
#                                  changed ALONE, which npm does by itself (see below).
#   - a divergent branch        -> stop. --ff-only, never a merge: this is a deployment, and a merge
#                                  commit made by an update script is one nobody reviewed.
#   - no upstream, or no repo   -> stop and say so. A tarball cannot be updated in place.
#   - nothing to update         -> say so plainly and do nothing. No build, no launchctl.
#
# There is no migration step: the schema migrates itself when the database is opened (src/db/migrate.ts).
#
# PARCELS_NODE  which node to use; see scripts/lib/node.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The same node as install-agents.sh and setup.sh, so `npm ci` installs for the node the agents run.
. "$ROOT/scripts/lib/node.sh"

check_only=0
porcelain=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    # Machine-readable, and it IMPLIES --check: what the dashboard parses must never be one typo away
    # from installing something. The prose below is suppressed in this mode, because a page that
    # parsed English would quietly start reporting "up to date" the day a sentence was reworded.
    --porcelain) porcelain=1; check_only=1 ;;
    *) echo "usage: $0 [--check] [--porcelain]" >&2; exit 2 ;;
  esac
  shift
done

# The two voices this script has. Every line it prints goes through one of them, so neither mode can
# accidentally carry the other's output.
say() { [ "$porcelain" = 1 ] || echo "$@"; }
pline() { [ "$porcelain" = 0 ] || echo "$@"; }
# require_node announces which node it picked on stdout, which is prose; in porcelain mode it is dropped.
NODE_MSG_TO=/dev/stdout
[ "$porcelain" = 0 ] || NODE_MSG_TO=/dev/null

git_() { git -C "$ROOT" "$@"; }
# A refusal. In porcelain mode the first line is also emitted as `state blocked` / `reason ...`, so a
# caller that only reads stdout still learns both that it was refused and why; the exit status is 1
# either way, and that - not the output - is what src/core/update.ts treats as authoritative.
die() {
  pline "state blocked"
  pline "reason $1"
  echo "update: $1" >&2
  shift
  for l in "$@"; do echo "  $l" >&2; done
  exit 1
}

# The machine-readable answer: one `key value` line per fact, `log <sha> <subject>` once per commit
# that would be installed. Unknown keys are ignored by the reader, so lines may be added here; the
# keys that exist must not change meaning. Prints nothing at all unless --porcelain was given.
porcelain_report() { # porcelain_report <state>
  [ "$porcelain" = 1 ] || return 0
  echo "state $1"
  echo "version $(pkg_version)"
  echo "branch ${BRANCH:-}"
  echo "local $(git_ rev-parse HEAD)"
  [ -z "${UPSTREAM:-}" ] || echo "upstream $UPSTREAM"
  [ -z "${REMOTE:-}" ] || echo "remote $REMOTE"
  [ "$1" = behind ] || return 0
  echo "behind $(git_ rev-list --count "HEAD..$UPSTREAM")"
  git_ log --oneline --no-decorate "HEAD..$UPSTREAM" | while IFS= read -r l; do echo "log $l"; done
}

# `rev-parse --git-dir` would answer from a parent repository, so ask whether the root ITSELF is the
# top of a work tree: a tarball unpacked inside someone's checkout must not be "updated" by pulling
# that outer repository over it. Both sides are resolved with `pwd -P` because git reports a physical
# path and $ROOT is a logical one - under /var, which is a symlink, they are spelled differently.
real() { [ -d "$1" ] && (cd "$1" && pwd -P); }
TOP="$(git_ rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TOP" ] && [ "$(real "$TOP")" = "$(real "$ROOT")" ] || die \
  "$ROOT is not a git checkout, so there is nothing to pull." \
  "Updating an unpacked copy means replacing the directory by hand, keeping config.json and data/."

# Where we are now. The version comes from package.json; the commit is what dist/ was built from.
# Two functions, because the porcelain report needs the version on a line of its own.
pkg_version() {
  "$NODE" -e '
    try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)) }
    catch { process.stdout.write("?") }
  ' "$ROOT/package.json"
}
describe() { printf '%s (%s)\n' "$(pkg_version)" "$(git_ rev-parse --short HEAD)"; }

require_node scripts/update.sh > "$NODE_MSG_TO"
BRANCH="$(git_ rev-parse --abbrev-ref HEAD)"
# A detached HEAD has no upstream and nothing to fast-forward; say that, rather than complain a
# branch called "HEAD" is not tracking anything.
[ "$BRANCH" != HEAD ] || die \
  "this checkout is on a detached HEAD, not a branch, so there is nothing to fast-forward." \
  "Check out the branch you want to follow first: git checkout main"
BEFORE="$(describe)"
say "at version $BEFORE on branch $BRANCH"

# --- the refusals -----------------------------------------------------------------------------------
# config.json, data/ and dist/ are gitignored, so none of them can make the tree dirty; anything that
# shows up here is a real edit to tracked code, and the user is the only one who knows what it was for.
DIRTY="$(git_ status --porcelain --untracked-files=no)"
# Except package-lock.json on its own. npm rewrites it without being asked: a newer npm than the one
# that wrote it adds metadata on `npm install` (npm 12, which Node 26 ships, adds `hasInstallScript`),
# and setup.sh ran `npm install` until it switched to `npm ci`. Nobody chose that change, and `npm ci`
# below installs from the lock file of the commit being pulled, so it is set aside rather than refused -
# but only when it is the WHOLE difference: a package.json changed beside it means somebody changed the
# dependencies on purpose, and that is refused like any other edit.
LOCK_ONLY=0
if [[ "$DIRTY" =~ ^[\ M][\ M]\ package-lock\.json$ ]]; then LOCK_ONLY=1; DIRTY=""; fi
[ -z "$DIRTY" ] || {
  # Named, so the Health page (and a support bundle) says WHICH files: these are paths of the app's own
  # tracked files, never anything of the user's. The first three, and how many more.
  n="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
  files="$(printf '%s\n' "$DIRTY" | cut -c4- | head -3 | paste -sd, - | sed 's/,/, /g')"
  [ "$n" -le 3 ] || files="$files and $((n - 3)) more"
  pline "state blocked"
  pline "reason the working tree has uncommitted changes ($files), so nothing was updated."
  echo "update: the working tree has uncommitted changes ($files), so nothing was updated." >&2
  echo "$DIRTY" | sed 's/^/  /' >&2
  echo "  Commit, stash or discard them, then run this again." >&2
  exit 1
}

UPSTREAM="$(git_ rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
[ -n "$UPSTREAM" ] || die \
  "branch $BRANCH is not tracking anything, so there is nowhere to update from." \
  "Set one: git branch --set-upstream-to=origin/$BRANCH $BRANCH"

# The only network access in this script, and the only thing --check does: it moves remote-tracking
# refs and touches neither the working tree nor the branch.
say "fetching $UPSTREAM ..."
git_ fetch --quiet --prune

LOCAL="$(git_ rev-parse HEAD)"
REMOTE="$(git_ rev-parse "$UPSTREAM")"

if [ "$LOCAL" = "$REMOTE" ]; then
  state=current
elif git_ merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  state=behind
elif git_ merge-base --is-ancestor "$REMOTE" "$LOCAL"; then
  state=ahead
else
  state=diverged
fi

case "$state" in
  diverged)
    die "$BRANCH and $UPSTREAM have diverged: they each have commits the other does not." \
      "This script only fast-forwards; merging or rebasing is a decision for you." \
      "  git log --oneline --left-right $BRANCH...$UPSTREAM"
    ;;
  ahead)
    porcelain_report ahead
    say "nothing to update: $BRANCH is ahead of $UPSTREAM by $(git_ rev-list --count "$UPSTREAM..HEAD") local commit(s)."
    say "  Already running the newest code there is here. Push them if they are meant to be shared."
    exit 0
    ;;
esac

if [ "$check_only" = 1 ]; then
  porcelain_report "$state"
  if [ "$state" = current ]; then
    say "up to date: $BEFORE is the newest commit on $UPSTREAM. Nothing to do."
  else
    say "an update is available: $(git_ rev-list --count "HEAD..$UPSTREAM") commit(s) behind $UPSTREAM."
    [ "$porcelain" = 1 ] || git_ log --oneline --no-decorate "HEAD..$UPSTREAM" | sed 's/^/  /'
    say "  Run scripts/update.sh to install it."
  fi
  exit 0
fi

if [ "$state" = current ]; then
  echo "nothing to update: $BEFORE is already the newest commit on $UPSTREAM."
  echo "  Nothing was built and launchd was not touched. To rebuild and reload anyway:"
  echo "    scripts/install-agents.sh"
  exit 0
fi

# --- the update -------------------------------------------------------------------------------------
echo "updating $(git_ rev-list --count "HEAD..$UPSTREAM") commit(s) ..."
# --ff-only turns a surprise into an error instead of a merge commit. The checks above should have
# caught every case, but this is the one that is enforced by git rather than by this script.
if [ "$LOCK_ONLY" = 1 ]; then
  echo "setting aside package-lock.json, which npm rewrote by itself (npm ci reinstalls from the new one) ..."
  git_ checkout --quiet HEAD -- package-lock.json
fi
git_ pull --ff-only --quiet

# `ci`, not `install`: it installs exactly what package-lock.json says, which is what the commit we
# just pulled was tested with, and it fails loudly if the lock file and package.json disagree.
echo "installing dependencies (npm ci) ..."
run_npm "$ROOT" ci

# Rebuilds dist/ and re-bootstraps both agents, so the running code is the code just pulled.
echo "rebuilding and reloading the agents ..."
"$ROOT/scripts/install-agents.sh"

AFTER="$(describe)"
cat <<EOF

== Updated: $BEFORE -> $AFTER
The database migrated itself if it needed to; the web agent is already running the new code.
If the dashboard still looks old, it is the browser: reload it.
EOF
