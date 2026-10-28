#!/bin/bash
# Checks scripts/install-hostname.sh WITHOUT root: it edits /etc/hosts, so it is never run here. What
# can go wrong without sudo is checked instead - chiefly which port it reads out of config.json, which
# decides the URL it tests and prints. Run directly, or via test/install-hostname.test.ts under vitest.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "ok   $d"; else echo "FAIL $d"; fail=1; fi
}

SCRIPT="$ROOT/scripts/install-hostname.sh"
LIB="$ROOT/scripts/lib/port.sh"

check "install-hostname.sh parses"                    bash -n "$SCRIPT"
check "lib/port.sh parses"                            bash -n "$LIB"
check "install-hostname.sh sources lib/port.sh"       grep -qE '^\. .*lib/port\.sh' "$SCRIPT"
check "it no longer scrapes \"port\" with sed"        bash -c "! grep -nE '^[^#]*sed[^|]*\"port\"' '$SCRIPT'"

# port_of <json>  -> what config_port says for a config.json with exactly this content
port_of() { printf '%s' "$1" > "$TMP/config.json"; bash -c ". '$LIB'; config_port '$TMP/config.json'"; }

# The bug: the first "port" anywhere in the file won, and an imap block sits above the top-level one.
check "the top-level port wins over imap.port before it"  test "$(port_of '{"imap":{"host":"imap.gmail.com","port":993},"port":9000}')" = 9000
check "the top-level port wins over imap.port after it"   test "$(port_of '{"port":9001,"imap":{"port":993}}')" = 9001
check "imap.port alone is not the web port"                test "$(port_of '{"imap":{"host":"h","port":993,"user":"u"}}')" = 8787
check "no port at all falls back to 8787"                  test "$(port_of '{"defaultPostalCode":"85101"}')" = 8787
check "a non-numeric port falls back to 8787"              test "$(port_of '{"port":"abc"}')" = 8787
check "a fractional port falls back to 8787"               test "$(port_of '{"port":8787.5}')" = 8787
check "an absurdly long number falls back to 8787"         test "$(port_of '{"port":1234567}')" = 8787
check "a file that is not JSON falls back to 8787"         test "$(port_of 'not json at all')" = 8787
check "a missing file falls back to 8787"                  test "$(bash -c ". '$LIB'; config_port '$TMP/nope.json'")" = 8787

exit $fail
