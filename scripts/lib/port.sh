#!/bin/bash
# Which port the web server listens on, read from config.json. Sourced, never executed.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/port.sh"
#   PORT="$(config_port "$PROJECT/config.json")"
#
# plutil, not grep or sed: it parses the JSON, so it reads the TOP-LEVEL "port" and never imap.port
# (993), which a config with a mail account has as well - and a text search took whichever came first.
# plutil ships with macOS, needs no node, and behaves the same under sudo.

# config_port <config.json>  prints the top-level "port", or 8787 when it is missing or not a port number
config_port() {
  local found
  found="$(/usr/bin/plutil -extract port raw -o - "$1" 2>/dev/null || true)"
  case "$found" in
    ''|*[!0-9]*) echo 8787 ;;
    ??????*)     echo 8787 ;;   # more than five digits cannot be a port
    *)           echo "$found" ;;
  esac
}
