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
MIN_NODE_MAJOR=24

# launchd gives a job only PATH=/usr/bin:/bin:/usr/sbin:/sbin, so the plists have to name node by its
# absolute path. Which path that is differs per machine - nvm, Homebrew, the official installer - so
# it is discovered here rather than baked in. PARCELS_NODE overrides everything.
find_node() {
  if [ -n "${PARCELS_NODE:-}" ]; then printf '%s\n' "$PARCELS_NODE"; return; fi
  local n
  n="$(command -v node 2>/dev/null || true)"
  # A bare `node` may be an nvm shell function rather than a file, and shell functions do not exist
  # for launchd; only an executable file is any use here.
  if [ -n "$n" ] && [ -x "$n" ]; then printf '%s\n' "$n"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return; }
  done
  # Newest nvm install last, so `tail -1` is the highest version rather than the alphabetical one.
  ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1
}

NODE="$(find_node)"

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
case "$ROOT$NODE" in
  *[\&\<\>\"\']*) echo "install-agents: a path contains an XML-special character: $ROOT $NODE" >&2; exit 1 ;;
esac
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "install-agents: could not find a node binary." >&2
  echo "  Install Node ${MIN_NODE_MAJOR} or newer, or point PARCELS_NODE at it:" >&2
  echo "    PARCELS_NODE=/path/to/node scripts/install-agents.sh" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  echo "install-agents: $NODE is Node $NODE_MAJOR; this app needs $MIN_NODE_MAJOR or newer." >&2
  echo "  Upgrade it, or point PARCELS_NODE at a newer one." >&2
  exit 1
fi
# The build step below runs npm, which lives beside node; without it the agents would be registered
# against a dist/ that was never refreshed.
[ -x "$(dirname "$NODE")/npm" ] || { echo "install-agents: no npm beside $NODE" >&2; exit 1; }
echo "using node $("$NODE" -v) at $NODE"

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
# PATHs would not find either, so both come from the pinned directory. A failed build aborts here
# (set -e) with the old agents still registered, rather than loading code that did not build.
echo "building dist/ ..."
( cd "$ROOT" && PATH="$(dirname "$NODE"):$PATH" "$(dirname "$NODE")/npm" run build )

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
