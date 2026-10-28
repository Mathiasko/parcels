#!/bin/bash
# First run on a fresh Mac: prerequisites, dependencies, a config.json, and the launchd agents.
#
#   scripts/setup.sh                 the whole thing
#   scripts/setup.sh --config-only   prerequisites and config.json only: no npm install, no launchd
#
# Idempotent and safe to re-run. It never overwrites config.json (that file holds your App Password),
# npm ci installs exactly what package-lock.json says, and install-agents.sh replaces what is registered
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
# PARCELS_INSTALL_NODE    1 or 0 to answer the "install Node with Homebrew?" prompt without a tty.
# PARCELS_INSTALL_EXTRAS  1 or 0 to answer the optional-extras prompts the same way.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Which node runs this app: shared with install-agents.sh and update.sh, so the node that installs
# the dependencies is the same one the launchd agents will run.
. "$ROOT/scripts/lib/node.sh"
# Colour, marks, steps and spinners at a terminal; the plain text below everywhere else.
. "$ROOT/scripts/lib/ui.sh"

CONFIG="${PARCELS_CONFIG:-$ROOT/config.json}"
EXAMPLE="$ROOT/config.example.json"

config_only=0
case "${1:-}" in
  "") ;;
  --config-only) config_only=1 ;;
  *) echo "usage: $0 [--config-only]" >&2; exit 2 ;;
esac

# step <plain title> <title at a terminal>  ->  "== <plain>", or "● Step n of N  <title>".
STEP_N=0
STEP_OF=$([ "$config_only" = 1 ] && echo 2 || echo 4)
step() { STEP_N=$((STEP_N + 1)); if [ "$UI" = 1 ]; then ui_step "$STEP_N" "$STEP_OF" "$2"; else ui_step - - "$1"; fi; }

ui_banner "Parcels - setup" "Tracks your parcels from Gmail, on this Mac only."

# --- 1. the machine ---------------------------------------------------------------------------------
# macOS is not a preference: the scheduler is launchd, the notifications are macOS notifications, and
# the hostname script edits /etc/hosts. There is no other-platform path to fall back to.
step "Checking the machine" "Checking this Mac"
[ "$(uname -s)" = Darwin ] || {
  echo "setup: this app runs on macOS only (it needs launchd and macOS notifications)." >&2
  exit 1
}
ui_ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?') on $(uname -m)"

# --- 1b. node ---------------------------------------------------------------------------------------
# Node is the only thing this app needs that macOS does not ship. better-sqlite3 carries prebuilt
# darwin binaries, so there is nothing to compile and no Xcode requirement beyond what git already
# needed. If Homebrew is here we can offer to fix a missing or too-old Node in place; if it is not,
# say what to install and stop, because installing Homebrew itself is a system-wide change
# (a new /opt/homebrew, an edited shell profile, sudo) that an installer should never make unasked.
#
# PARCELS_INSTALL_NODE=1 answers the prompt yes, for a non-interactive run; =0 answers no.
offer_node() {
  find_node >/dev/null 2>&1 && require_node scripts/setup.sh 2>/dev/null >"$UI_PLAIN_ONLY" && return 0

  if ! command -v brew >/dev/null 2>&1; then
    require_node scripts/setup.sh   # prints exactly what is missing, and exits
    return
  fi

  ui_warn "Node ${MIN_NODE_MAJOR}+ is missing or too old, and Homebrew is available."
  local answer="${PARCELS_INSTALL_NODE:-}"
  if [ -z "$answer" ]; then
    if [ -t 0 ]; then
      ui_ask "Install Node with Homebrew?" "(brew install node) [y/N]" 'Install Node with "brew install node"? [y/N] '
      read -r answer || answer=n
    else
      answer=n
    fi
  fi
  case "$answer" in
    1|y|Y|yes|YES) ;;
    *) echo "setup: not installing. Run 'brew install node' yourself, then re-run this script." >&2; exit 1 ;;
  esac

  [ "$UI" = 1 ] || printf '\n== %s\n' "Installing Node (brew install node)"
  ui_run "Installing Node with Homebrew" brew install node || { echo "setup: brew install node failed." >&2; exit 1; }
  # A fresh Homebrew Node may not be on PATH yet in this shell; look where brew just put it.
  hash -r 2>/dev/null || true
  [ -x "$(brew --prefix)/bin/node" ] && PARCELS_NODE="${PARCELS_NODE:-$(brew --prefix)/bin/node}"
  require_node scripts/setup.sh >"$UI_PLAIN_ONLY"
}
offer_node
[ "$UI" = 0 ] || ui_ok "Node $("$NODE" -v) ${C_D}$NODE${C_0}"

# --- 1c. the optional extras -------------------------------------------------------------------------
# Everything below is a nicety, never a blocker: the app runs without any of it. Each is reported
# whether or not it is here, so one run tells you the whole picture instead of one thing at a time.

# git is not needed to RUN the app, only to update it. Someone who unpacked a tarball can still use
# everything; they just cannot `git pull`, and update.sh says so plainly rather than failing oddly.
if command -v git >/dev/null 2>&1; then
  ui_ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  ui_warn "git is not installed. The app runs fine; scripts/update.sh cannot pull updates without it."
  ui_info "Install with:  xcode-select --install      (or, with Homebrew:  brew install git)"
fi

# PARCELS_INSTALL_EXTRAS=1 answers these prompts yes, for a non-interactive run; =0 answers no.
offer_brew_formula() { # offer_brew_formula <command> <formula> <what it buys you>
  local cmd="$1" formula="$2" why="$3" answer
  if command -v "$cmd" >/dev/null 2>&1; then ui_ok "$cmd is installed"; return 0; fi
  ui_warn "$cmd is not installed. $why"
  if ! command -v brew >/dev/null 2>&1; then
    ui_info "Homebrew would install it. Homebrew itself is a system-wide change this script will not"
    ui_info "make for you; if you want it:"
    echo "      /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    ui_info "  brew install $formula"
    return 0
  fi
  answer="${PARCELS_INSTALL_EXTRAS:-}"
  if [ -z "$answer" ]; then
    if [ -t 0 ]; then ui_ask "Install $cmd?" "(brew install $formula) [y/N]" "Install it with \"brew install $formula\"? [y/N] "; read -r answer || answer=n
    else answer=n; fi
  fi
  case "$answer" in
    1|y|Y|yes|YES)
      ui_run "Installing $formula" brew install "$formula" || ui_info "brew install $formula failed; carrying on without it." ;;
    *) ui_info "Skipped. Install it later with:  brew install $formula" ;;
  esac
}

offer_brew_formula terminal-notifier terminal-notifier \
  "Without it, notifications fall back to osascript: they appear, but with no app identity and no click-through."

# --- 2. dependencies --------------------------------------------------------------------------------
if [ "$config_only" = 0 ]; then
  # `ci`, not `install`: install can rewrite package-lock.json (a newer npm adds its own metadata), and a
  # tracked file changed by the installer is a dirty tree that blocks every update after it.
  step "Installing dependencies (npm ci)" "Installing what the app needs"
  ui_run "Installing dependencies (npm ci)" run_npm "$ROOT" ci || exit 1
fi

# --- 3. config.json ---------------------------------------------------------------------------------
# Created only if absent, and never touched otherwise: by the second run this file holds a Gmail App
# Password, and losing that to a re-run of the installer would be unforgivable. The file it writes has
# no `imap` block at all, which is the clean "no mail account configured" state - /settings fills it.
make_config() {
  if [ -e "$CONFIG" ]; then
    ui_ok "$CONFIG already exists: keeping it exactly as it is."
    ui_note "  Nothing in setup ever overwrites it. Edit it on /settings, or by hand."
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
    ui_note "GLS and DPD will not answer without a postcode, so the app needs a default one."
    ui_note "It is overridable per parcel later, and editable on /settings."
    local attempt
    for attempt in 1 2 3; do
      ui_ask "Your postcode" "(five digits, e.g. 81101)" 'Your postcode (five digits, e.g. 81101): '
      read -r postcode || postcode=''
      postcode="${postcode//[[:space:]]/}"
      [[ "$postcode" =~ ^[0-9]{5}$ ]] && { ui_answered "Postcode" "$postcode"; break; }
      ui_warn "\"$postcode\" is not a postcode. Five digits, like 81101."
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
  ui_ok "wrote $CONFIG (mode $(stat -f %Lp "$CONFIG"), postcode $postcode, no mail account yet)"
}

step "Configuration" "Your settings"
make_config

# --- 4. the launchd agents --------------------------------------------------------------------------
if [ "$config_only" = 0 ]; then
  step "Installing the launchd agents" "Starting the app"
  # This also runs `npm run build`, so dist/ exists before the agents are told to run it.
  ui_run "Building the app and starting its two background jobs" "$ROOT/scripts/install-agents.sh" || exit 1
fi

# --- 5. what is left for a human --------------------------------------------------------------------
PORT="$("$NODE" -e '
  try {
    const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port
    process.stdout.write(String(Number.isInteger(p) ? p : 8787))
  } catch { process.stdout.write("8787") }
' "$CONFIG")"

# Whether a mail account is saved yet: the one thing left that matters, and the reason to open the page.
MAIL_SET="$("$NODE" -e '
  try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).imap ? "1" : "0") }
  catch { process.stdout.write("0") }
' "$CONFIG")"
SETTINGS_URL="http://127.0.0.1:$PORT/settings"

# --config-only did not install the dependencies or the agents, so it must not claim to have.
if [ "$config_only" = 1 ]; then
  HEADLINE="Config written. Run setup.sh with no flags to install the rest, then connect Gmail."; TONE=todo
elif [ "$MAIL_SET" = 1 ]; then
  HEADLINE="Installed. Gmail is already connected; the dashboard is at http://127.0.0.1:$PORT"; TONE=ok
else
  HEADLINE="Installed. One thing is left: connect Gmail, which takes about five minutes."; TONE=ok
fi

ui_headline "$HEADLINE" "$TONE"

[ "$MAIL_SET" = 1 ] || cat <<EOF

Open ${C_C}$SETTINGS_URL${C_0} - the "How to connect Gmail" box at the top of that page
walks you through it, with a link for every step. In short:

  ${C_B}1. Label your shipping emails.${C_0}
     a. On the Settings page, click ${C_B}gmail-filter.xml${C_0}. It downloads to your Downloads folder.
     b. In Gmail: gear icon -> ${C_B}See all settings${C_0} -> ${C_B}Filters and Blocked Addresses${C_0}.
     c. At the bottom of that page, click ${C_B}Import filters${C_0}.
     d. Click ${C_B}Choose File${C_0} and pick gmail-filter.xml in Downloads.
     e. Click ${C_B}Open file${C_0}.
     f. Tick "${C_B}Apply new filters to existing email${C_0}", so the mail you already have is labelled too.
     g. Click ${C_B}Create filters${C_0}.
     h. Settings -> Labels: find parcels and make sure "${C_B}Show in IMAP${C_0}" is ticked.
  ${C_B}2. Make an App Password${C_0} (2-Step Verification must be on).
     a. Open ${C_C}https://myaccount.google.com/apppasswords${C_0}
     b. Type a name such as Parcels and click ${C_B}Create${C_0}.
     c. Copy the 16-letter password it shows.
  ${C_B}3. Back on the Settings page${C_0}, enter your Gmail address and the App Password, click ${C_B}Save settings${C_0},
     and read the one-line answer at the top.

${C_D}Until then the app still works: add parcels by hand on /add.${C_0}
EOF

cat <<EOF

${C_B}Optional${C_0}, each in a real Terminal window:
  - A nicer address, ${C_C}http://parcels.local:$PORT${C_0} instead of the IP (asks for your password):
      sudo scripts/install-hostname.sh
  - Notifications with the app's name and click-through: run
      terminal-notifier -title x -message y
    and approve the macOS prompt. Check which one is live with: node dist/cli.js notify-test

${C_D}Later, Health -> Check for updates (or scripts/update.sh) installs a newer version. README.md has the rest.${C_0}
EOF

# A fresh install from a real Terminal: open the page that finishes it, once the web agent answers (it
# was bootstrapped seconds ago). Not under --config-only, which started no server; not without a
# terminal, so a test or a script never opens a browser; not once mail is set up, so a re-run does not.
if [ "$config_only" = 0 ] && [ "$MAIL_SET" = 0 ] && [ -t 1 ] && [ -z "${PARCELS_NO_OPEN:-}" ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS -o /dev/null --max-time 1 "$SETTINGS_URL" 2>/dev/null && break
    sleep 1
  done
  echo
  if open "$SETTINGS_URL" 2>/dev/null; then ui_ok "Opened $SETTINGS_URL in your browser"
  else ui_warn "Could not open $SETTINGS_URL - paste it into your browser."; fi
fi
