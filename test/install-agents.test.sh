#!/bin/bash
# Renders the plists with --no-load into a temp directory (launchd is never touched) and checks
# them. Run directly, or via test/install-agents.test.ts under vitest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $d"; else echo "FAIL $d"; fail=1; fi
}

PARCELS_AGENTS_DIR="$TMP" "$ROOT/scripts/install-agents.sh" --no-load >/dev/null || { echo "FAIL install-agents.sh --no-load"; exit 1; }
P="$TMP/local.parcels.poller.plist"
W="$TMP/local.parcels.web.plist"
NODE=/Users/you/.nvm/versions/node/v24.21.0/bin/node
key() { plutil -extract "$2" raw -o - "$1"; }

check "both plists pass plutil -lint"                plutil -lint "$P" "$W"
check "plists are mode 644"                          test "$(stat -f %Lp "$P")" = 644 -a "$(stat -f %Lp "$W")" = 644
check "no placeholder is left behind"                test -z "$(grep -l __ABS_DIR__ "$P" "$W")"
check "poller labelled correctly"                    test "$(key "$P" Label)" = local.parcels.poller
check "poller runs caffeinate -i"                    test "$(key "$P" ProgramArguments.0)" = /usr/bin/caffeinate -a "$(key "$P" ProgramArguments.1)" = -i
check "poller uses the absolute node path"           test "$(key "$P" ProgramArguments.2)" = "$NODE"
check "poller runs the absolute dist/poll.js"        test "$(key "$P" ProgramArguments.3)" = "$ROOT/dist/poll.js"
check "poller has exactly 16 calendar slots"         test "$(key "$P" StartCalendarInterval)" = 16
check "slots are 7..21 on the hour plus 15:30"       test "$(for i in $(seq 0 15); do echo "$(key "$P" StartCalendarInterval.$i.Hour):$(key "$P" StartCalendarInterval.$i.Minute)"; done | tr '\n' ' ')" = "7:0 8:0 9:0 10:0 11:0 12:0 13:0 14:0 15:0 15:30 16:0 17:0 18:0 19:0 20:0 21:0 "
check "both reminder times have a run to fire from" bash -c "for t in 8:0 15:30; do for i in \$(seq 0 15); do test \"\$(plutil -extract StartCalendarInterval.\$i.Hour raw -o - '$P'):\$(plutil -extract StartCalendarInterval.\$i.Minute raw -o - '$P')\" = \"\$t\" && continue 2; done; exit 1; done"
check "poller has no StartInterval"                  bash -c "! plutil -extract StartInterval raw -o - '$P'"
check "poller logs live under data/"                 test "$(key "$P" StandardOutPath)" = "$ROOT/data/poll.log" -a "$(key "$P" StandardErrorPath)" = "$ROOT/data/poll.err.log"
check "poller sets WorkingDirectory to the project"  test "$(key "$P" WorkingDirectory)" = "$ROOT"
check "poller PATH is explicit"                      grep -qx "$(dirname "$NODE")" <(key "$P" EnvironmentVariables.PATH | tr ':' '\n')
check "web is KeepAlive and RunAtLoad"               test "$(key "$W" KeepAlive)" = true -a "$(key "$W" RunAtLoad)" = true
check "web uses the absolute node + dist/server.js"  test "$(key "$W" ProgramArguments.0)" = "$NODE" -a "$(key "$W" ProgramArguments.1)" = "$ROOT/dist/server.js"
check "web has no StartInterval"                     bash -c "! plutil -extract StartInterval raw -o - '$W'"
check "install script never uses launchctl load"     bash -c "! grep -E '^[^#]*launchctl[[:space:]]+(load|unload)' '$ROOT/scripts/install-agents.sh'"
check "install script uses bootstrap on gui/<uid>"   grep -q 'launchctl bootstrap "\$DOMAIN"' "$ROOT/scripts/install-agents.sh"
check "domain is gui/, not user/"                    grep -q 'DOMAIN="gui/\$(id -u)"' "$ROOT/scripts/install-agents.sh"
check "install script builds dist/ before it bootstraps" bash -c "b=\$(grep -n 'run build' '$ROOT/scripts/install-agents.sh' | grep -v '^[0-9]*:#' | head -1 | cut -d: -f1); l=\$(grep -n 'launchctl bootstrap' '$ROOT/scripts/install-agents.sh' | head -1 | cut -d: -f1); test -n \"\$b\" -a -n \"\$l\" -a \"\$b\" -lt \"\$l\""
check "install script does not build under --no-load" bash -c "! PARCELS_AGENTS_DIR='$TMP' '$ROOT/scripts/install-agents.sh' --no-load | grep -q building"

exit $fail
