#!/bin/bash
# Installs the two launchd agents for this project: renders launchd/*.plist.template into
# ~/Library/LaunchAgents (absolute project dir substituted, chmod 644), then bootout + bootstrap
# each one into the gui/<uid> domain. Re-running is safe: it replaces what is registered.
#
#   scripts/install-agents.sh             install and (re)load both agents
#   scripts/install-agents.sh --no-load   write the plists only, do not touch launchd
#
# PARCELS_AGENTS_DIR overrides the destination directory (used by the test).
set -euo pipefail

NODE=/Users/you/.nvm/versions/node/v24.21.0/bin/node
LABELS=(local.parcels.poller local.parcels.web)

load=1
case "${1:-}" in
  "") ;;
  --no-load) load=0 ;;
  *) echo "usage: $0 [--no-load]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${PARCELS_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
DOMAIN="gui/$(id -u)"

# The path goes into XML verbatim, so refuse characters that would corrupt it.
case "$ROOT" in
  *[\&\<\>\"\']*) echo "install-agents: project path contains an XML-special character: $ROOT" >&2; exit 1 ;;
esac
# launchd supplies only PATH=/usr/bin:/bin:/usr/sbin:/sbin; the plists name node absolutely.
[ -x "$NODE" ] || { echo "install-agents: node not found at $NODE" >&2; exit 1; }

mkdir -p "$DEST" "$ROOT/data"   # launchd will not create the log directory, and the job fails to start without it

for label in "${LABELS[@]}"; do
  template="$ROOT/launchd/$label.plist.template"
  plist="$DEST/$label.plist"
  [ -f "$template" ] || { echo "install-agents: missing $template" >&2; exit 1; }

  content="$(<"$template")"
  printf '%s\n' "${content//__ABS_DIR__/$ROOT}" > "$plist"
  chmod 644 "$plist"
  plutil -lint "$plist" >/dev/null
  echo "wrote $plist"
done

[ "$load" = 1 ] || exit 0

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
