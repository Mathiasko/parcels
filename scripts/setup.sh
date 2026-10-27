#!/bin/bash
# First run on a fresh Mac: prerequisites, dependencies, a config.json, and the launchd agents.
#
#   scripts/setup.sh                 the whole thing
#   scripts/setup.sh --config-only   prerequisites and config.json only: no npm install, no launchd
#
# Idempotent and safe to re-run. It never overwrites config.json (that file holds your App Password),
# npm install is a no-op when nothing changed, and install-agents.sh replaces what is registered
# rather than adding to it. No sudo anywhere: the only root-owned part of this app is the optional
# parcels.local hostname, which is a separate script you run yourself.
#
# It deliberately does NOT ask for your Gmail App Password. The /settings page edits the same file
# and has a Test mail connection button that says in one line whether the credentials actually work.
# A prompt here could only store them and hope; the page can prove them.
#
# PARCELS_CONFIG    which config file to create (default <repo>/config.json). Used by the test.
# PARCELS_POSTCODE  answers the postcode prompt, for a non-interactive run.
# PARCELS_NODE      which node to use; see scripts/lib/node.sh.
# PARCELS_INSTALL_NODE  1 or 0 to answer the "install Node with Homebrew?" prompt without a tty.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Which node runs this app: shared with install-agents.sh and update.sh, so the node that installs
# the dependencies is the same one the launchd agents will run.
. "$ROOT/scripts/lib/node.sh"

CONFIG="${PARCELS_CONFIG:-$ROOT/config.json}"
EXAMPLE="$ROOT/config.example.json"

config_only=0
case "${1:-}" in
  "") ;;
  --config-only) config_only=1 ;;
  *) echo "usage: $0 [--config-only]" >&2; exit 2 ;;
esac

step() { printf '\n== %s\n' "$1"; }

# --- 1. the machine ---------------------------------------------------------------------------------
# macOS is not a preference: the scheduler is launchd, the notifications are macOS notifications, and
# the hostname script edits /etc/hosts and pf. There is no other-platform path to fall back to.
step "Checking the machine"
[ "$(uname -s)" = Darwin ] || {
  echo "setup: this app runs on macOS only (it needs launchd and macOS notifications)." >&2
  exit 1
}
echo "macOS $(sw_vers -productVersion 2>/dev/null || echo '?') on $(uname -m)"

# --- 1b. node ---------------------------------------------------------------------------------------
# Node is the only thing this app needs that macOS does not ship. better-sqlite3 carries prebuilt
# darwin binaries, so there is nothing to compile and no Xcode requirement beyond what git already
# needed. If Homebrew is here we can offer to fix a missing or too-old Node in place; if it is not,
# say what to install and stop, because installing Homebrew itself is a system-wide change
# (a new /opt/homebrew, an edited shell profile, sudo) that an installer should never make unasked.
#
# PARCELS_INSTALL_NODE=1 answers the prompt yes, for a non-interactive run; =0 answers no.
offer_node() {
  find_node >/dev/null 2>&1 && require_node scripts/setup.sh 2>/dev/null && return 0

  if ! command -v brew >/dev/null 2>&1; then
    require_node scripts/setup.sh   # prints exactly what is missing, and exits
    return
  fi

  echo "Node ${MIN_NODE_MAJOR}+ is missing or too old, and Homebrew is available."
  local answer="${PARCELS_INSTALL_NODE:-}"
  if [ -z "$answer" ]; then
    if [ -t 0 ]; then
      printf 'Install Node with "brew install node"? [y/N] '
      read -r answer || answer=n
    else
      answer=n
    fi
  fi
  case "$answer" in
    1|y|Y|yes|YES) ;;
    *) echo "setup: not installing. Run 'brew install node' yourself, then re-run this script." >&2; exit 1 ;;
  esac

  step "Installing Node (brew install node)"
  brew install node || { echo "setup: brew install node failed." >&2; exit 1; }
  # A fresh Homebrew Node may not be on PATH yet in this shell; look where brew just put it.
  hash -r 2>/dev/null || true
  [ -x "$(brew --prefix)/bin/node" ] && PARCELS_NODE="${PARCELS_NODE:-$(brew --prefix)/bin/node}"
  require_node scripts/setup.sh
}
offer_node

# --- 2. dependencies --------------------------------------------------------------------------------
if [ "$config_only" = 0 ]; then
  step "Installing dependencies (npm install)"
  run_npm "$ROOT" install
fi

# --- 3. config.json ---------------------------------------------------------------------------------
# Created only if absent, and never touched otherwise: by the second run this file holds a Gmail App
# Password, and losing that to a re-run of the installer would be unforgivable. The file it writes has
# no `imap` block at all, which is the clean "no mail account configured" state - /settings fills it.
make_config() {
  if [ -e "$CONFIG" ]; then
    echo "$CONFIG already exists: keeping it exactly as it is."
    echo "  Nothing in setup ever overwrites it. Edit it on /settings, or by hand."
    return 0
  fi
  [ -f "$EXAMPLE" ] || { echo "setup: $EXAMPLE is missing; cannot write a config." >&2; return 1; }

  local postcode="${PARCELS_POSTCODE:-}"
  if [ -n "$postcode" ]; then
    postcode="${postcode//[[:space:]]/}"
  elif [ ! -t 0 ]; then
    echo "setup: there is no config.json and no terminal to ask for the postcode." >&2
    echo "  Re-run from a Terminal window, or set PARCELS_POSTCODE=81101 and re-run." >&2
    return 1
  else
    echo "GLS and DPD will not answer without a postcode, so the app needs a default one."
    echo "It is overridable per parcel later, and editable on /settings."
    local attempt
    for attempt in 1 2 3; do
      printf 'Your postcode (five digits, e.g. 81101): '
      read -r postcode || postcode=''
      postcode="${postcode//[[:space:]]/}"
      [[ "$postcode" =~ ^[0-9]{5}$ ]] && break
      echo "  \"$postcode\" is not a postcode. Five digits, like 81101."
      postcode=''
    done
  fi
  # The same rule the settings page applies (src/web/settings.ts), so a file written here is one the
  # page will accept. It is also what makes the value safe to hand to the writer below.
  [[ "$postcode" =~ ^[0-9]{5}$ ]] || {
    echo "setup: no valid postcode given, so no config.json was written." >&2
    return 1
  }

  # Written by node rather than a heredoc so config.example.json stays the single source of the
  # shipped defaults: this is that file, with your postcode, minus the imap placeholders. Mode 0600
  # from creation - never written readable and chmodded afterwards.
  "$NODE" -e '
    const { readFileSync, writeFileSync } = require("node:fs")
    const [example, target, postcode] = process.argv.slice(1)
    const doc = JSON.parse(readFileSync(example, "utf8"))
    delete doc.imap
    doc.defaultPostalCode = postcode
    writeFileSync(target, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  ' "$EXAMPLE" "$CONFIG" "$postcode"
  chmod 600 "$CONFIG"   # also repairs the mode if the file was somehow created readable
  echo "wrote $CONFIG (mode $(stat -f %Lp "$CONFIG"), postcode $postcode, no mail account yet)"
}

step "Configuration"
make_config

# --- 4. the launchd agents --------------------------------------------------------------------------
if [ "$config_only" = 0 ]; then
  step "Installing the launchd agents"
  # This also runs `npm run build`, so dist/ exists before the agents are told to run it.
  "$ROOT/scripts/install-agents.sh"
fi

# --- 5. what is left for a human --------------------------------------------------------------------
PORT="$("$NODE" -e '
  try {
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port
    process.stdout.write(String(Number.isInteger(p) ? p : 8787))
  } catch { process.stdout.write("8787") }
' "$CONFIG")"

# --config-only did not install the dependencies or the agents, so it must not claim to have.
[ "$config_only" = 0 ] && HEADLINE="Installed. Four things are left, and none of them can be scripted:" \
                       || HEADLINE="Config written. Run setup.sh with no flags to install the rest. Then:"

cat <<EOF

== $HEADLINE

1. Open the dashboard:  http://127.0.0.1:$PORT
   It binds loopback only and has no password, by design.

2. Finish Gmail on the Settings page, http://127.0.0.1:$PORT/settings
   - Make an App Password at https://myaccount.google.com/apppasswords (2-step verification first).
   - Fill in the imap fields there and Save, then press "Test mail connection". Read the answer:
     it is the only thing that proves ingest works, rather than quietly reading an empty label.
   - In Gmail, import gmail-filter.xml (Settings, Filters and Blocked Addresses, Import filters)
     and tick "Also apply filter to matching conversations" - import alone labels nothing that has
     already arrived. Then Settings, Labels, tick "Show in IMAP" for the parcels label.
   Until that is done the app still works; you just add parcels by hand on /add.

3. Optional, needs a password prompt in a real Terminal:
     sudo scripts/install-hostname.sh
   That gives you http://parcels.local instead of a port number.

4. Optional, one-time macOS approval for nicer notifications: in a real Terminal window run
     terminal-notifier -title x -message y
   and approve the prompt. Without it the app falls back to osascript, which works but has no app
   identity and no click-through. Check which one is live with: node dist/cli.js notify-test

Then: scripts/update.sh pulls and reinstalls later. README.md has the rest.
EOF
