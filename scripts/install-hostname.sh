#!/bin/bash
# Serves the dashboard at http://parcels.local instead of http://127.0.0.1:8787.
#
# Three pieces are needed, and all three are root-owned, which is why this is a script you read before
# running rather than a line in the README:
#
#   1. /etc/hosts            resolves parcels.local to this machine, and nowhere else.
#   2. /etc/pf.anchors/...   redirects loopback port 80 to the port the app actually listens on. A process
#                            without root cannot bind a port below 1024, so the app keeps its own port and
#                            the kernel moves the packets. The app is NOT run as root.
#   3. a LaunchDaemon        re-applies the pf rule at boot; pf is disabled by default on macOS and does
#                            not remember being enabled.
#
# The matching code change is the Host allow-list in src/web/server.ts: the server refuses a Host header it
# does not know, so without that, parcels.local would get a 403 rather than the dashboard.
#
# Every edit is marked with the sentinels below, is skipped if already present, and is undone by --uninstall.
# /etc/hosts and /etc/pf.conf are backed up next to themselves before the first change.

set -euo pipefail

HOST_NAME="parcels.local"
LABEL="local.parcels.pf"
ANCHOR="/etc/pf.anchors/parcels"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
BEGIN="# >>> parcels tracker"
END="# <<< parcels tracker"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root:  sudo $0 ${1:-}"

# The redirect has to point at the port the app is really on, so read it rather than assume 8787.
PORT=8787
if [ -f "$PROJECT/config.json" ]; then
  FOUND=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' "$PROJECT/config.json" | head -1 || true)
  [ -n "$FOUND" ] && PORT="$FOUND"
fi

strip_block() {   # strip_block <file> - removes our sentinel block, leaving everything else alone
  local f="$1"
  [ -f "$f" ] || return 0
  /usr/bin/sed -i '' "/^${BEGIN}\$/,/^${END}\$/d" "$f"
}

uninstall() {
  echo "Removing ${HOST_NAME}..."
  if [ -f "$PLIST" ]; then
    launchctl bootout "system/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"; note "removed ${PLIST}"
  fi
  strip_block /etc/hosts;   note "cleaned /etc/hosts"
  strip_block /etc/pf.conf; note "cleaned /etc/pf.conf"
  rm -f "$ANCHOR";          note "removed ${ANCHOR}"
  if pfctl -n -f /etc/pf.conf 2>/dev/null; then
    pfctl -f /etc/pf.conf 2>/dev/null || true
    note "reloaded pf (left enabled; it is harmless and other software may rely on it)"
  fi
  echo "Done. The dashboard is still at http://127.0.0.1:${PORT}"
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall
[ -z "${1:-}" ] || die "usage: $0 [--uninstall]"

echo "Installing ${HOST_NAME} -> 127.0.0.1:${PORT}"

# --- 1. /etc/hosts ---------------------------------------------------------------------------------
if grep -q "^${BEGIN}\$" /etc/hosts; then
  # Our own block: rewrite it rather than leave it, so a correction here reaches a machine that
  # already ran an older version of this script.
  cp -p /etc/hosts "/etc/hosts.parcels-backup-$(date +%s)"
  strip_block /etc/hosts
  printf '%s\n127.0.0.1\t%s\n%s\n' "$BEGIN" "$HOST_NAME" "$END" >> /etc/hosts
  note "refreshed ${HOST_NAME} in /etc/hosts"
elif grep -qE "^[^#]*[[:space:]]${HOST_NAME}([[:space:]]|$)" /etc/hosts; then
  note "/etc/hosts already resolves ${HOST_NAME} by some other means, left alone"
else
  cp -p /etc/hosts "/etc/hosts.parcels-backup-$(date +%s)"
  # IPv4 only, deliberately. The pf rule below redirects port 80 for 127.0.0.1, and a redirect cannot
  # send IPv6 traffic to an IPv4 listener - the server binds 127.0.0.1 and nothing else. Publishing a
  # ::1 answer as well would hand browsers an address with no listener on it, which costs a Happy
  # Eyeballs timeout before they fall back: the opposite of the stall it looks like it prevents.
  printf '%s\n127.0.0.1\t%s\n%s\n' "$BEGIN" "$HOST_NAME" "$END" >> /etc/hosts
  note "added ${HOST_NAME} to /etc/hosts"
fi

# --- 2. the pf anchor ------------------------------------------------------------------------------
# `rdr pass on lo0` is the part that matters: the redirect has to be applied on the loopback interface,
# because a request from this Mac to 127.0.0.1 never touches a physical one.
cat > "$ANCHOR" <<EOF
# Written by ${PROJECT}/scripts/install-hostname.sh - edits here are overwritten on re-run.
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${PORT}
EOF
chmod 644 "$ANCHOR"; chown root:wheel "$ANCHOR"
note "wrote ${ANCHOR}"

# --- 3. /etc/pf.conf -------------------------------------------------------------------------------
# Order is load-bearing in pf.conf: every rdr-anchor must precede the filter anchors, so this goes
# directly after Apple's rdr-anchor rather than at the end of the file.
if grep -q "^${BEGIN}\$" /etc/pf.conf; then
  note "/etc/pf.conf already references our anchor, left alone"
else
  cp -p /etc/pf.conf "/etc/pf.conf.parcels-backup-$(date +%s)"
  /usr/bin/awk -v b="$BEGIN" -v e="$END" '
    { print }
    /^rdr-anchor "com\.apple\/\*"$/ && !done {
      print b; print "rdr-anchor \"parcels\""; print "load anchor \"parcels\" from \"/etc/pf.anchors/parcels\""; print e
      done = 1
    }
  ' /etc/pf.conf > /tmp/pf.conf.parcels && mv /tmp/pf.conf.parcels /etc/pf.conf
  chmod 644 /etc/pf.conf; chown root:wheel /etc/pf.conf
  grep -q "^${BEGIN}\$" /etc/pf.conf || die "could not find Apple's rdr-anchor line to insert after; /etc/pf.conf is not stock"
  note "added the anchor to /etc/pf.conf"
fi

# Validate BEFORE loading: a syntax error here would otherwise leave pf with no ruleset at all.
pfctl -n -f /etc/pf.conf || die "/etc/pf.conf failed validation and was NOT loaded; restore a .parcels-backup-* file"
note "pf.conf validates"

# --- 4. load it now, and at every boot --------------------------------------------------------------
pfctl -E -f /etc/pf.conf 2>&1 | sed 's/^/  pf: /' || die "pfctl could not enable pf"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- pf is disabled by default on macOS and does not persist across a reboot, so the redirect that makes
     http://${HOST_NAME} work has to be re-applied at every boot. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/sbin/pfctl</string><string>-E</string><string>-f</string><string>/etc/pf.conf</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
chmod 644 "$PLIST"; chown root:wheel "$PLIST"
launchctl bootout "system/${LABEL}" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
note "installed ${PLIST}"

# --- 5. prove it ------------------------------------------------------------------------------------
echo
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${HOST_NAME}/" || echo 000)
if [ "$CODE" = "200" ]; then
  echo "http://${HOST_NAME} -> HTTP ${CODE}. Done."
else
  echo "http://${HOST_NAME} -> HTTP ${CODE} (expected 200)."
  echo "The web agent may not be running. Check:  launchctl print gui/\$(id -u)/local.parcels.web"
  echo "A 403 means the server is up but does not know the hostname: rebuild with 'npm run build' and"
  echo "restart it, so the Host allow-list change in src/web/server.ts is live."
  exit 1
fi
