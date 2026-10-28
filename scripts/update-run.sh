#!/bin/bash
# Runs scripts/update.sh on behalf of the Update button on /health, records how it went, and puts the
# checkout back if the new code does not work.
#
#   scripts/update-run.sh      update, recording the outcome in data/update-status.json
#
# Nobody runs this by hand; the web server spawns it DETACHED (see `startUpdate` in
# src/core/update.ts). Two things follow from that, and they are the whole reason this file exists
# rather than the server simply running scripts/update.sh:
#
#   1. Nothing is left to report the outcome. The update ends by re-bootstrapping the launchd web
#      agent, which is the process that started it: by the time the update finishes, its parent is
#      gone and a fresh web server is running the new code. So the outcome travels through a file -
#      this script writes it, and the next page view reads it (`adoptUpdateOutcome`).
#   2. A failed build must not leave a dead dashboard. install-agents.sh refuses to touch launchd if
#      the build fails, but `git pull` plus `npm ci` can still land a tree that does not build at all.
#      The commit we started on is therefore recorded BEFORE anything is pulled, and on failure the
#      checkout is put back to it and rebuilt. A friend who presses Update and loses his dashboard is
#      worse off than one who never updates.
#
# Deliberately NOT `set -e`: every failure here has to be recorded in the status file rather than
# inherited, including the failure of the rollback.
#
# Two seams, both so the test can exercise the rollback without npm, the network or launchd - the
# same arrangement as install-agents.sh's PARCELS_AGENTS_DIR:
#
#   PARCELS_UPDATE_SCRIPT   the updater to run      (default: scripts/update.sh)
#   PARCELS_UPDATE_REBUILD  the rebuild+reload step (default: npm ci, then install-agents.sh)
#
# And two the server sets, so both halves describe one run:
#
#   PARCELS_UPDATE_STATUS   where to write the outcome (default: data/update-status.json)
#   PARCELS_UPDATE_STARTED  the ISO instant the server recorded as the start of this run
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

STATUS="${PARCELS_UPDATE_STATUS:-$ROOT/data/update-status.json}"
UPDATER="${PARCELS_UPDATE_SCRIPT:-$ROOT/scripts/update.sh}"
REBUILD="${PARCELS_UPDATE_REBUILD:-}"

# The start time comes from the server, which already wrote a "running" status under it, so the page
# that is following this run and the outcome it ends up reading are the same run. A value that is not
# an ISO instant is not used: it goes into a JSON file this app parses.
STARTED="${PARCELS_UPDATE_STARTED:-}"
case "$STARTED" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z) ;;
  *) STARTED="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" ;;
esac

git_() { git -C "$ROOT" "$@"; }
# The commit, or empty when this is not a checkout at all - in which case update.sh will refuse and
# there is nothing to roll back to, which is exactly what an empty BEFORE means below.
head_sha() { git_ rev-parse HEAD 2>/dev/null || true; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

mkdir -p "$(dirname "$STATUS")" 2>/dev/null

# write <state> <from> <to> <rollback> <exit> <finished>
#
# One line of JSON, written to a temporary file and renamed into place, so a page reading it never
# sees half of it. Every value is generated here - a state, a rollback and a timestamp from closed
# sets, two commit shas from git, one exit status - so none of them can carry a quote or a newline
# into the file. The reader validates all of them again anyway (`readUpdateRun`).
write() {
  local state="$1" from="$2" to="$3" rollback="$4" code="$5" finished="$6"
  local tmp="$STATUS.tmp.$$"
  {
    printf '{"state":"%s","startedAt":"%s"' "$state" "$STARTED"
    [ -z "$finished" ] || printf ',"finishedAt":"%s"' "$finished"
    [ -z "$from" ] || printf ',"from":"%s"' "$from"
    [ -z "$to" ] || printf ',"to":"%s"' "$to"
    [ -z "$rollback" ] || printf ',"rollback":"%s"' "$rollback"
    [ -z "$code" ] || printf ',"exit":%s' "$code"
    printf '}\n'
  } > "$tmp" && mv -f "$tmp" "$STATUS"
}

# Dependencies back to what the restored commit's lock file says, then rebuild dist/ and reload the
# agents. `npm ci` is part of it because a rollback crosses a commit boundary in both directions and
# package-lock.json may have moved with it; install-agents.sh is what actually rebuilds and reloads,
# and it is the only thing in this app that is allowed to talk to launchd.
rebuild() {
  if [ -n "$REBUILD" ]; then
    "$REBUILD"
    return $?
  fi
  . "$ROOT/scripts/lib/node.sh"
  require_node scripts/update-run.sh || return 1
  run_npm "$ROOT" ci || return 1
  "$ROOT/scripts/install-agents.sh" || return 1
}

BEFORE="$(head_sha)"
write running "$BEFORE" "" "" "" ""
echo "=== $(now) update started, at ${BEFORE:-an unknown commit} ==="

"$UPDATER"
code=$?
AFTER="$(head_sha)"

if [ "$code" = 0 ]; then
  echo "=== $(now) update finished: ${BEFORE:-?} -> ${AFTER:-?} ==="
  write ok "$BEFORE" "$AFTER" "" 0 "$(now)"
  exit 0
fi

# It failed. If HEAD never moved, nothing was installed and there is nothing to undo - and a
# `git reset --hard` here would be actively harmful: the commonest reason update.sh refuses is a dirty
# working tree, and resetting would eat the very local edit it refused to touch.
if [ -z "$BEFORE" ] || [ "$AFTER" = "$BEFORE" ]; then
  echo "=== $(now) update refused (exit $code); nothing was installed and nothing was rolled back ==="
  write failed "$BEFORE" "$AFTER" none "$code" "$(now)"
  exit 1
fi

echo "=== $(now) update failed (exit $code) after moving to $AFTER; rolling back to $BEFORE ==="
rollback=failed
if git_ reset --hard "$BEFORE" >/dev/null 2>&1; then
  # Back on the old commit. It built before, so this should build again - but if even this fails the
  # machine is in a state only a person can sort out, and that has to be said rather than guessed at.
  if rebuild; then
    rollback=ok
    echo "=== $(now) rolled back to $BEFORE and rebuilt; the dashboard is running what it ran before ==="
  else
    echo "=== $(now) rolled back to $BEFORE but could NOT rebuild; this needs a person ==="
  fi
else
  echo "=== $(now) could not even roll back to $BEFORE; this needs a person ==="
fi
write failed "$BEFORE" "$(head_sha)" "$rollback" "$code" "$(now)"
exit 1
