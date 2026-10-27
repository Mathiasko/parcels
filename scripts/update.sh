#!/bin/bash
# Updates an installed copy: fast-forward the checkout, reinstall dependencies, rebuild, reload the
# launchd agents. Prints the version and commit before and after.
#
#   scripts/update.sh           update, if there is anything to update
#   scripts/update.sh --check   say whether an update is available, and change nothing else
#
# Safe by default, which here means four refusals rather than four guesses:
#
#   - a dirty working tree      -> stop, and name the files. An update must never be the thing that
#                                  eats a local edit, and `git pull` into a dirty tree either fails
#                                  halfway or quietly merges.
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
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

git_() { git -C "$ROOT" "$@"; }
die() { echo "update: $1" >&2; shift; for l in "$@"; do echo "  $l" >&2; done; exit 1; }

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
describe() {
  local v
  v="$("$NODE" -e '
    try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)) }
    catch { process.stdout.write("?") }
  ' "$ROOT/package.json")"
  printf '%s (%s)\n' "$v" "$(git_ rev-parse --short HEAD)"
}

require_node scripts/update.sh
BRANCH="$(git_ rev-parse --abbrev-ref HEAD)"
# A detached HEAD has no upstream and nothing to fast-forward; say that, rather than complain a
# branch called "HEAD" is not tracking anything.
[ "$BRANCH" != HEAD ] || die \
  "this checkout is on a detached HEAD, not a branch, so there is nothing to fast-forward." \
  "Check out the branch you want to follow first: git checkout main"
BEFORE="$(describe)"
echo "at version $BEFORE on branch $BRANCH"

# --- the refusals -----------------------------------------------------------------------------------
# config.json, data/ and dist/ are gitignored, so none of them can make the tree dirty; anything that
# shows up here is a real edit to tracked code, and the user is the only one who knows what it was for.
DIRTY="$(git_ status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || {
  echo "update: the working tree has uncommitted changes, so nothing was updated." >&2
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
echo "fetching $UPSTREAM ..."
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
    echo "nothing to update: $BRANCH is ahead of $UPSTREAM by $(git_ rev-list --count "$UPSTREAM..HEAD") local commit(s)."
    echo "  Already running the newest code there is here. Push them if they are meant to be shared."
    exit 0
    ;;
esac

if [ "$check_only" = 1 ]; then
  if [ "$state" = current ]; then
    echo "up to date: $BEFORE is the newest commit on $UPSTREAM. Nothing to do."
  else
    echo "an update is available: $(git_ rev-list --count "HEAD..$UPSTREAM") commit(s) behind $UPSTREAM."
    git_ log --oneline --no-decorate "HEAD..$UPSTREAM" | sed 's/^/  /'
    echo "  Run scripts/update.sh to install it."
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
