#!/bin/bash
# Which node runs this app, and whether it is usable. Sourced, never executed.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/node.sh"
#   NODE="$(find_node)"        # the first USABLE node, or empty
#   require_node setup         # validates, sets NODE and NPM, or returns 1 with advice
#
# This lives in one file because three scripts need it and they must not disagree. install-agents.sh
# bakes the answer into the launchd plists; setup.sh and update.sh run npm with it. If they picked
# different binaries, the agents would run a different Node from the one that built dist/.
MIN_NODE_MAJOR=24

# Every node worth considering, best candidate first. More than one, because the first node on PATH
# is not always a usable one: toolchains (Codex, VS Code, Electron apps) ship a private node with no
# npm beside it, and picking that one and giving up strands a machine that has a perfectly good Node
# somewhere else. PARCELS_NODE still wins outright.
node_candidates() {
  [ -n "${PARCELS_NODE:-}" ] && printf '%s\n' "$PARCELS_NODE"
  # A bare `node` may be an nvm shell function rather than a file, and shell functions do not exist
  # for launchd; only an executable file is any use here.
  local n
  n="$(command -v node 2>/dev/null || true)"
  [ -n "$n" ] && [ -x "$n" ] && printf '%s\n' "$n"
  local c
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && printf '%s\n' "$c"
  done
  # Newest nvm install first, by version rather than alphabetically (v24.9 sorts after v24.11).
  ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV
}

# node_rejection <path>  ->  prints why this node cannot be used, or nothing if it can.
# npm is required, not optional: every caller either builds or installs, and npm must sit beside node
# because the PATH launchd gives a job would not find it anywhere else.
node_rejection() {
  local cand="$1" major
  [ -x "$cand" ] || { printf 'not an executable file\n'; return; }
  major="$("$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$major" in ''|*[!0-9]*) printf 'did not report a version\n'; return ;; esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ] || { printf 'Node %s, need %s or newer\n' "$major" "$MIN_NODE_MAJOR"; return; }
  [ -x "$(dirname "$cand")/npm" ] || { printf 'no npm beside it\n'; return; }
}

# The first candidate with nothing wrong with it, or empty.
find_node() {
  local cand
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    [ -z "$(node_rejection "$cand")" ] && { printf '%s\n' "$cand"; return 0; }
  done <<EOF
$(node_candidates)
EOF
  return 1
}

# require_node <prog>  ->  sets NODE and NPM, or returns 1 having said what was tried and what to do.
# <prog> only names the complaining script in the messages.
require_node() {
  local prog="${1:-parcels}"
  NODE="$(find_node)" || NODE=""
  if [ -n "$NODE" ]; then
    NPM="$(dirname "$NODE")/npm"
    echo "using node $("$NODE" -v) at $NODE"
    return 0
  fi

  # Nothing usable. Say what was examined and why each one was turned down: "no npm beside it" on a
  # path the user has never heard of is baffling without the list.
  local cand why found=0
  echo "$prog: found no usable Node ${MIN_NODE_MAJOR}+ installation." >&2
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    found=1
    why="$(node_rejection "$cand")"
    printf '    %s - %s\n' "$cand" "${why:-unknown}" >&2
  done <<EOF
$(node_candidates)
EOF
  [ "$found" = 1 ] || echo "    (no node binary found at all)" >&2
  echo "  Install Node ${MIN_NODE_MAJOR} or newer - 'brew install node', or https://nodejs.org -" >&2
  echo "  or point PARCELS_NODE at one that already works:" >&2
  echo "    PARCELS_NODE=/path/to/node $prog" >&2
  return 1
}

# Run npm from the pinned directory, with its own bin dir first on PATH. npm shells out to node by
# name, so a bare `npm` under a launchd-style PATH would find neither.
run_npm() { ( cd "$1" && shift && PATH="$(dirname "$NODE"):$PATH" "$NPM" "$@" ); }
