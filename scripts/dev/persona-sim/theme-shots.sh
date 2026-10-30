#!/bin/bash
# Screenshots of every page of the app, for a pixel diff between two commits or two themes
# (docs/superpowers/specs/2026-10-30-themes-design.md §2).
#
#   [SIM_THEME=classic] [SIM_MODE=light] scripts/dev/persona-sim/theme-shots.sh <out-dir>
#
# Starts persona eva in a fixed folder (so no temp path differs between runs), lives days 0-5, then shoots
# /, /history, /attention, /health, /settings, /add, the first parcel the dashboard links, and the first-run
# page, each at 1280 and 390 px, light and dark, into <out-dir>/<slug>-<width>[-dark].png. SIM_THEME and
# SIM_MODE are passed to the simulator; a commit from before themes simply ignores them.
# Shots are taken with reduced motion (Chrome's --force-prefers-reduced-motion); SIM_MOTION=1 lets the page move.
set -euo pipefail

OUT="${1:?usage: theme-shots.sh <out-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM="$HERE/sim"
DAYS=5
SIMDIR="${TMPDIR:-/tmp}"
SIMDIR="${SIMDIR%/}/parcels-theme-shots-eva"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

"$SIM" start eva --dir "$SIMDIR" >/dev/null
trap '"$SIM" stop --as eva >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 "$DAYS"); do "$SIM" day --as eva >/dev/null; done

parcel="$("$SIM" text / --as eva | grep -oE '→ /parcel/[0-9]+$' | head -1 | sed 's/^→ //')"
[ -n "$parcel" ] || { echo "theme-shots: the dashboard links no parcel" >&2; exit 1; }

for page in / /history /attention /health /settings /add "$parcel" app:first-run; do
  case "$page" in
    /) slug=dashboard ;;
    app:first-run) slug=first-run ;;
    *) slug="$(printf '%s' "${page#/}" | tr '/' '-')" ;;
  esac
  for width in 1280 390; do
    "$SIM" shot "$page" --as eva --width "$width" --out "$OUT/$slug-$width.png" >/dev/null
    "$SIM" shot "$page" --as eva --width "$width" --dark --out "$OUT/$slug-$width-dark.png" >/dev/null
  done
  echo "shot $page"
done
echo "theme-shots: $(ls "$OUT"/*.png | wc -l | tr -d ' ') screenshots in $OUT (parcel page: $parcel)"
