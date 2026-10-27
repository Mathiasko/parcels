#!/bin/bash
# Installs the two launchd agents for this project: renders launchd/*.plist.template into
# ~/Library/LaunchAgents (absolute project dir substituted, chmod 644), then bootout + bootstrap
# each one into the gui/<uid> domain. Re-running is safe: it replaces what is registered.
# Before loading it runs `npm run build`: dist/ is gitignored build output, and the agents run it,
# so without this a loaded agent could silently keep running stale code.
#
#   scripts/install-agents.sh             install and (re)load both agents
#   scripts/install-agents.sh --no-load   write the plists only: no build, do not touch launchd
#
# PARCELS_AGENTS_DIR overrides the destination directory (used by the test).
set -euo pipefail

LABELS=(local.parcels.poller local.parcels.web)

# Which node to bake into the plists: scripts/lib/node.sh, shared with setup.sh and update.sh so the
# node that builds dist/ can never differ from the node the agents run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/node.sh"

load=1
case "${1:-}" in
  "") ;;
  --no-load) load=0 ;;
  *) echo "usage: $0 [--no-load]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${PARCELS_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
DOMAIN="gui/$(id -u)"

# Sets NODE and NPM, or exits having said what to install. It insists on npm beside node too, which
# this script needs: without the build step below the agents would be registered against a dist/
# that was never refreshed.
require_node scripts/install-agents.sh

# The path goes into XML verbatim, so refuse characters that would corrupt it.
case "$ROOT$NODE" in
  *[\&\<\>\"\']*) echo "install-agents: a path contains an XML-special character: $ROOT $NODE" >&2; exit 1 ;;
esac

mkdir -p "$DEST" "$ROOT/data"   # launchd will not create the log directory, and the job fails to start without it

for label in "${LABELS[@]}"; do
  template="$ROOT/launchd/$label.plist.template"
  plist="$DEST/$label.plist"
  [ -f "$template" ] || { echo "install-agents: missing $template" >&2; exit 1; }

  content="$(<"$template")"
  content="${content//__ABS_DIR__/$ROOT}"
  content="${content//__NODE_DIR__/$(dirname "$NODE")}"
  content="${content//__NODE__/$NODE}"
  printf '%s\n' "$content" > "$plist"
  chmod 644 "$plist"
  plutil -lint "$plist" >/dev/null
  echo "wrote $plist"
done

[ "$load" = 1 ] || exit 0

# Refresh dist/ before anything is bootstrapped. npm sits next to node, and launchd-style minimal
# PATHs would not find either, so both come from the pinned directory (`run_npm`). A failed build
# aborts here (set -e) with the old agents still registered, rather than loading code that did not build.
echo "building dist/ ..."
run_npm "$ROOT" run build

for label in "${LABELS[@]}"; do
  plist="$DEST/$label.plist"
  case "$label" in
    *.poller) entry="$ROOT/dist/poll.js" ;;
    *.web) entry="$ROOT/dist/server.js" ;;
  esac
  # A KeepAlive agent whose entry point is missing would crash-loop, so register it only once built.
  if [ ! -f "$entry" ]; then
    echo "skipped $label: $entry does not exist (run the build first, then re-run this script)" >&2
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    continue
  fi
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  # bootout returns before the service is fully gone; bootstrap can briefly fail with EIO meanwhile.
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "$DOMAIN" "$plist"; then echo "bootstrapped $DOMAIN/$label"; break; fi
    [ "$attempt" = 5 ] && { echo "install-agents: bootstrap failed for $label" >&2; exit 1; }
    sleep 1
  done
done
