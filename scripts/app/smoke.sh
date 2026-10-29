#!/bin/bash
# Proves that a built Parcels.app starts its server and stops cleanly, without touching this Mac.
#
#   scripts/app/smoke.sh                 builds this Mac's app (signed) into release/, then smoke-tests it
#   scripts/app/smoke.sh --no-build      smoke-tests the app already in release/
#   scripts/app/smoke.sh --app PATH      smoke-tests the app at PATH (implies --no-build)
#
# The app runs with HOME set to a new temporary folder that holds a minimal config on a free port, and
# with PARCELS_SMOKE=1, which makes main.ts skip the login item, the offer to move to Applications and
# the window. Everything it writes (config, database, logs, Chromium's state) lands in that folder.
# The script then:
#   1. waits up to 30 s for http://127.0.0.1:<port>/health to answer;
#   2. checks that the port is held by one of the app's own child processes (the server runs as a
#      utility process whose command line does not name app-server.js, so it is found by its port);
#   3. fetches /gmail-filter.xml, which the server reads from Contents/Resources;
#   4. sends SIGTERM to the app, as logout and `kill` do, and requires it to exit within 10 s, leaving
#      nothing listening on the port and none of its children running;
#   5. checks that the real ~/Library/Application Support/Parcels and ~/Library/Logs/Parcels were
#      neither created nor changed.
# It prints "smoke: ok" when all of that holds, and exits non-zero with the reason otherwise.
#
# The binary is run directly rather than with `open`, so HOME and PARCELS_SMOKE reach it, and without
# ELECTRON_RUN_AS_NODE, which some terminals set (the app's RunAsNode fuse is off, so it would be
# ignored anyway; unsetting it keeps this test about the app and not the fuse).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../lib/node.sh
. "$ROOT/scripts/lib/node.sh"

build=1
app=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) build=0; shift ;;
    --app) [ "$#" -ge 2 ] || { echo "smoke: --app needs a path" >&2; exit 2; }; app="$2"; build=0; shift 2 ;;
    *) echo "smoke: \"$1\" is not an option; it takes --no-build and --app PATH" >&2; exit 2 ;;
  esac
done

case "$(uname -m)" in
  arm64) arch=arm64; outdir="$ROOT/release/mac-arm64" ;;
  x86_64) arch=x64; outdir="$ROOT/release/mac" ;;
  *) echo "smoke: this Mac's architecture $(uname -m) has no build" >&2; exit 2 ;;
esac
[ -n "$app" ] || app="$outdir/Parcels.app"

fail() {
  echo "smoke: FAIL: $1" >&2
  exit 1
}

require_node smoke >/dev/null || exit 1

if [ "$build" = 1 ]; then
  echo "smoke: building $arch into $outdir"
  run_npm "$ROOT" run build:app || fail "npm run build:app failed"
  # `dir` makes only the .app, signed by the after-pack hook like a release; no zip or dmg.
  (cd "$ROOT" && PATH="$(dirname "$NODE"):$PATH" "$NODE" node_modules/.bin/electron-builder --mac dir "--$arch") \
    || fail "electron-builder failed"
fi

bin="$app/Contents/MacOS/Parcels"
[ -x "$bin" ] || fail "there is no app at $app; build it first (npm run app:dist)"
resources="$app/Contents/Resources"
cmp -s "$resources/signing-cert.sha256" "$ROOT/app/signing-cert.sha256" \
  || fail "$resources/signing-cert.sha256 is missing or differs from app/signing-cert.sha256; the app would refuse every update"
[ -f "$resources/gmail-filter.xml" ] || fail "$resources/gmail-filter.xml is missing"

# --- the real Library, before ---------------------------------------------------------------------
# From the user database, not $HOME: the point is the real one whatever this shell's HOME says.
real_home="$(/usr/bin/dscl . -read "/Users/$(id -un)" NFSHomeDirectory | awk '{ print $2 }')"
[ -d "$real_home" ] || fail "could not find the real home folder"
real_dirs=("$real_home/Library/Application Support/Parcels" "$real_home/Library/Logs/Parcels")
snapshot() {
  local d
  for d in "${real_dirs[@]}"; do
    if [ -e "$d" ]; then find "$d" -exec stat -f '%N %m %z %p' {} + 2>&1; else echo "absent: $d"; fi
  done
}
before="$(snapshot)"
# AppKit keeps a few of its own defaults (text direction and the like) for every app it runs, through
# cfprefsd, which writes into the real ~/Library/Preferences whatever HOME says. A plist the smoke run
# created is removed again afterwards; one that was already there belongs to a real install and is left.
prefs="$real_home/Library/Preferences/local.parcels.app.plist"
prefs_existed=0
[ -e "$prefs" ] && prefs_existed=1

# --- a temporary HOME with a config on a free port ------------------------------------------------
tmp="${TMPDIR:-/tmp}"
home="$(mktemp -d "${tmp%/}/parcels-smoke.XXXXXX")"
[ -n "$home" ] && [ -d "$home" ] || { echo "smoke: could not make a temporary HOME." >&2; exit 1; }
pid=""
kids=""
cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null; fi
  local k
  for k in $kids; do kill -KILL "$k" 2>/dev/null; done
  rm -rf "$home"
  # Through `defaults` first, so cfprefsd forgets the domain and does not write the file back.
  if [ "$prefs_existed" = 0 ] && [ -e "$prefs" ]; then
    defaults delete local.parcels.app >/dev/null 2>&1
    rm -f "$prefs"
  fi
}
trap cleanup EXIT

support="$home/Library/Application Support/Parcels"
logs="$home/Library/Logs/Parcels"
mkdir -p "$support" && chmod 700 "$support"
port="$("$NODE" -e "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close() })")"
[[ "$port" =~ ^[0-9]+$ ]] || fail "could not find a free port"
# 8787 is a real install's port. The system never hands it out as a free port, but a smoke run must
# not even try it.
[ "$port" != 8787 ] || fail "was given port 8787, which belongs to a real install"
# The welcome page's config, with a postcode and the free port. No imap: the smoke run never polls mail.
cat > "$support/config.json" <<EOF
{
  "defaultPostalCode": "81101",
  "dbPath": "data/parcels.db",
  "port": $port,
  "notifier": "auto",
  "mapPreview": false,
  "pickupCalendar": ""
}
EOF
chmod 600 "$support/config.json"

# --- start ------------------------------------------------------------------------------------------
echo "smoke: starting $app with HOME=$home on port $port"
# CFFIXED_USER_HOME points macOS's own idea of home (NSHomeDirectory, user defaults, saved state) at
# the temporary folder too; HOME alone covers only what Node and the app read.
env -u ELECTRON_RUN_AS_NODE HOME="$home" CFFIXED_USER_HOME="$home" PARCELS_SMOKE=1 "$bin" > "$home/stdout.log" 2>&1 &
pid=$!
started=$(date +%s)

show_logs() {
  echo "--- main.log" >&2; tail -n 20 "$logs/main.log" 2>/dev/null >&2
  echo "--- server.log" >&2; tail -n 20 "$logs/server.log" 2>/dev/null >&2
  echo "--- stdout/stderr" >&2; tail -n 20 "$home/stdout.log" 2>/dev/null >&2
}

health=""
for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || { show_logs; fail "the app exited before its server answered"; }
  if health="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null)"; then break; fi
  health=""
  sleep 0.5
done
[ -n "$health" ] || { show_logs; fail "/health did not answer on port $port within 30 s"; }
echo "smoke: /health answered after $(( $(date +%s) - started )) s"

# --- who holds the port -------------------------------------------------------------------------------
descendants() {
  local c
  for c in $(pgrep -P "$1"); do echo "$c"; descendants "$c"; done
}
kids="$(descendants "$pid" | tr '\n' ' ')"
listener="$(lsof -nP -a -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
[ -n "$listener" ] || fail "nothing listens on port $port, though /health answered"
case " $kids " in
  *" $listener "*) ;;
  *) fail "port $port is held by pid $listener, which is not one of the app's processes ($kids)" ;;
esac
echo "smoke: port $port is held by pid $listener ($(ps -o comm= -p "$listener" | sed 's#.*/##')), a child of the app (pid $pid)"
echo "smoke: the app's processes:"
plist="$pid"
for k in $kids; do plist="$plist,$k"; done
ps -o pid=,ppid=,comm= -p "$plist" 2>/dev/null \
  | awk '{ n = $3; for (i = 4; i <= NF; i++) n = n " " $i; sub(/.*\//, "", n); printf "  pid %s, parent %s: %s\n", $1, $2, n }'

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/gmail-filter.xml")"
[ "$code" = 200 ] || fail "/gmail-filter.xml answered $code: the server cannot read Contents/Resources"
echo "smoke: /gmail-filter.xml answered 200 from Contents/Resources"

grep -q "smoke run" "$logs/main.log" 2>/dev/null || fail "main.log under the temporary HOME does not mention the smoke run"
[ -f "$support/data/parcels.db" ] || fail "the database was not created under the temporary HOME"
[ -d "$support/Chromium" ] || fail "Chromium's state is not under the temporary HOME's support folder"

# --- quit with SIGTERM -----------------------------------------------------------------------------------
kill -TERM "$pid"
term_at=$(date +%s)
for _ in $(seq 1 100); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then show_logs; fail "the app was still running 10 s after SIGTERM"; fi
wait "$pid"
status=$?
pid=""
echo "smoke: the app exited $status within $(( $(date +%s) - term_at )) s of SIGTERM"
[ "$status" = 0 ] || { show_logs; fail "the app exited $status after SIGTERM, not 0"; }

# Children are reaped by the system after their parent; give them a moment, not a free pass.
left=""
for _ in $(seq 1 20); do
  left=""
  for k in $kids; do kill -0 "$k" 2>/dev/null && left="$left $k"; done
  [ -z "$left" ] && break
  sleep 0.1
done
[ -z "$left" ] || fail "child processes still running after the app exited:$left"
if lsof -nP -a -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then fail "port $port is still listened on after the app exited"; fi
kids=""
echo "smoke: no child process is left and nothing listens on port $port"
grep -q "quitting" "$logs/main.log" || fail "main.log does not show the app quitting through its own path"

# --- the real Library, after ----------------------------------------------------------------------
after="$(snapshot)"
[ "$before" = "$after" ] || fail "the real Library changed: $(diff <(echo "$before") <(echo "$after"))"
echo "smoke: the real ~/Library/Application Support/Parcels and ~/Library/Logs/Parcels are unchanged ($(echo "$after" | tr '\n' ';'))"
if [ "$prefs_existed" = 0 ] && [ -e "$prefs" ]; then
  echo "smoke: macOS wrote its own defaults to $prefs; it is removed on exit"
fi

echo "smoke: ok"
