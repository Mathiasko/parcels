#!/bin/bash
# Which node runs this app, and whether it is usable. Sourced, never executed.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/node.sh"
#   NODE="$(find_node)"        # a path, or empty
#   require_node setup         # validates, exports NODE and NPM, or exits 1 with advice
#
# This lives in one file because two scripts need it and they must not disagree. install-agents.sh
# bakes the answer into the launchd plists; setup.sh and update.sh run npm with it. If they picked
# different binaries, the agents would run a different Node from the one that built dist/.
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

# require_node <prog>  ->  sets NODE and NPM, or exits 1 having said what to install.
# <prog> only names the complaining script in the messages. npm is required too, not optional: every
# caller either builds or installs, and npm lives beside node rather than on the PATH launchd gives.
require_node() {
  local prog="${1:-parcels}"
  NODE="$(find_node)"
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    echo "$prog: could not find a node binary." >&2
    echo "  Install Node ${MIN_NODE_MAJOR} or newer, or point PARCELS_NODE at it:" >&2
    echo "    PARCELS_NODE=/path/to/node $prog" >&2
    return 1
  fi
  local major
  major="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    echo "$prog: $NODE is Node $major; this app needs $MIN_NODE_MAJOR or newer." >&2
    echo "  Upgrade it, or point PARCELS_NODE at a newer one." >&2
    return 1
  fi
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || { echo "$prog: no npm beside $NODE" >&2; return 1; }
  echo "using node $("$NODE" -v) at $NODE"
}

# Run npm from the pinned directory, with its own bin dir first on PATH. npm shells out to node by
# name, so a bare `npm` under a launchd-style PATH would find neither.
run_npm() { ( cd "$1" && shift && PATH="$(dirname "$NODE"):$PATH" "$NPM" "$@" ); }
