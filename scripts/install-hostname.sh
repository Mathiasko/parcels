#!/bin/bash
# Serves the dashboard at http://parcels.local:8787 instead of http://127.0.0.1:8787.
#
#   sudo scripts/install-hostname.sh              add the name
#   sudo scripts/install-hostname.sh --uninstall  remove it, and any older pf setup this script left
#
# One root-owned edit, to /etc/hosts. It is backed up first, every line is inside the sentinels below,
# and --uninstall takes them out again.
#
# BOTH address families are written, and that is not decoration. macOS resolves a `.local` name through
# mDNS as well as /etc/hosts, and with only an A record it waits about five seconds for an AAAA answer
# that never comes before falling back - five seconds on every single connection. With `::1` present the
# v6 attempt is refused immediately (nothing listens there; the server binds 127.0.0.1 only) and the
# client falls straight back to v4. Measured on this machine: v4-only 5.01s to connect, both families
# 0.005s.
#
# WHAT THIS NO LONGER DOES, and why. It used to redirect loopback port 80 to 8787 with a pf rule, so the
# URL could omit the port. A process without root cannot bind a port below 1024, so that was the only way
# - but `rdr pass on lo0 ... -> 127.0.0.1 port 8787` makes pf swallow DIRECT connections to 8787 as well.
# The documented fallback URL, the one setup.sh prints, silently stopped accepting connections at all:
# not refused, dropped, so every client sat there until it timed out. A trivial server put on 8787 with
# the app stopped behaved identically, which is what proved it was the packet filter rather than the app.
# Four characters of URL are not worth a root-level packet filter that can blackhole the application, on
# someone else's Mac, with no error anywhere to explain it.
#
# The matching code change is the Host allow-list in src/web/server.ts: the server refuses a Host header
# it does not know, so without that, parcels.local would get a 403 rather than the dashboard.

set -euo pipefail

HOST_NAME="parcels.local"
BEGIN="# >>> parcels tracker"
END="# <<< parcels tracker"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Everything the pf era left behind, removed by --uninstall whichever label installed it.
OLD_LABELS=(local.parcels.pf sk.matuslaco.parcels.pf)
ANCHOR="/etc/pf.anchors/parcels"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "  $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root:  sudo $0 ${1:-}"

# The top-level "port" only, never imap.port; 8787 when config.json has none. See lib/port.sh.
. "$PROJECT/scripts/lib/port.sh"
PORT="$(config_port "$PROJECT/config.json")"

strip_block() {   # strip_block <file> - removes our sentinel block, leaving everything else alone
  local f="$1"
  [ -f "$f" ] || return 0
  /usr/bin/sed -i '' "/^${BEGIN}\$/,/^${END}\$/d" "$f"
}

# The pf redirect is gone for good; this takes out whatever an older version of this script installed,
# including the daemon under the label the project used before it was renamed.
remove_pf() {
  local label removed=0
  for label in "${OLD_LABELS[@]}"; do
    if [ -f "/Library/LaunchDaemons/${label}.plist" ]; then
      launchctl bootout "system/${label}" 2>/dev/null || true
      rm -f "/Library/LaunchDaemons/${label}.plist"
      note "removed the boot job ${label}"
      removed=1
    fi
  done
  if [ -f /etc/pf.conf ] && grep -q "^${BEGIN}\$" /etc/pf.conf; then
    cp -p /etc/pf.conf "/etc/pf.conf.parcels-backup-$(date +%s)"
    strip_block /etc/pf.conf
    note "took our anchor out of /etc/pf.conf"
    removed=1
  fi
  [ -f "$ANCHOR" ] && { rm -f "$ANCHOR"; note "removed $ANCHOR"; removed=1; }
  if [ "$removed" = 1 ] && pfctl -n -f /etc/pf.conf 2>/dev/null; then
    pfctl -f /etc/pf.conf 2>/dev/null || true
    note "reloaded pf without it"
  fi
  # pf is left exactly as enabled or disabled as it was found: other software may rely on it, and this
  # script has no way to know whether it was the one that turned it on.
}

uninstall() {
  echo "Removing ${HOST_NAME}..."
  remove_pf
  strip_block /etc/hosts; note "cleaned /etc/hosts"
  echo "Done. The dashboard is at http://127.0.0.1:${PORT}"
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall
[ -z "${1:-}" ] || die "usage: $0 [--uninstall]"

echo "Installing ${HOST_NAME} -> 127.0.0.1 (port ${PORT})"
remove_pf   # idempotent, and repairs a machine that ran the pf version of this script

if grep -q "^${BEGIN}\$" /etc/hosts; then
  # Our own block: rewrite it, so a correction here reaches a machine that ran an older version.
  cp -p /etc/hosts "/etc/hosts.parcels-backup-$(date +%s)"
  strip_block /etc/hosts
  printf '%s\n127.0.0.1\t%s\n::1\t%s\n%s\n' "$BEGIN" "$HOST_NAME" "$HOST_NAME" "$END" >> /etc/hosts
  note "refreshed ${HOST_NAME} in /etc/hosts (both address families)"
elif grep -qE "^[^#]*[[:space:]]${HOST_NAME}([[:space:]]|$)" /etc/hosts; then
  note "/etc/hosts already resolves ${HOST_NAME} by some other means, left alone"
else
  cp -p /etc/hosts "/etc/hosts.parcels-backup-$(date +%s)"
  printf '%s\n127.0.0.1\t%s\n::1\t%s\n%s\n' "$BEGIN" "$HOST_NAME" "$HOST_NAME" "$END" >> /etc/hosts
  note "added ${HOST_NAME} to /etc/hosts (both address families)"
fi

dscacheutil -flushcache 2>/dev/null || true

echo
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${HOST_NAME}:${PORT}/" || echo 000)
if [ "$CODE" = "200" ]; then
  echo "http://${HOST_NAME}:${PORT} -> HTTP ${CODE}. Done."
else
  echo "http://${HOST_NAME}:${PORT} -> HTTP ${CODE} (expected 200)."
  echo "  The web agent may not be running:  launchctl print gui/\$(id -u)/local.parcels.web"
  echo "  A 403 means the server is up but does not know the hostname: rebuild with 'npm run build'"
  echo "  and restart it, so the Host allow-list in src/web/server.ts is live."
  exit 1
fi
