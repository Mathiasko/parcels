# The installer's terminal UI: colour, ✓ / ! / ✗ marks, numbered steps, styled questions, a spinner
# for the long quiet steps, and a framed headline. Sourced by setup.sh.
#
# Only for a person at a terminal. With no terminal on stdout (a pipe, a log, a test), with NO_COLOR set
# (https://no-color.org) or with TERM=dumb, every function here prints exactly the plain text setup.sh
# printed before this file existed, so nothing that reads that output - the tests included - can tell
# the difference. FORCE_COLOR=1 turns it on without a terminal, which is how the test looks at it.
#
# Nothing here reads input: the `read`s stay in setup.sh, where its tests can see that it asks for
# nothing but a postcode and a yes or no.

if [ -n "${FORCE_COLOR:-}" ] || { [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; }; then
  UI=1
  C_B=$'\033[1m' C_D=$'\033[2m' C_0=$'\033[0m'
  C_G=$'\033[32m' C_Y=$'\033[33m' C_R=$'\033[31m' C_C=$'\033[36m'
else
  UI=0
  C_B='' C_D='' C_0='' C_G='' C_Y='' C_R='' C_C=''
fi

# Where a message meant only for the plain output goes: the UI says the same thing its own way.
if [ "$UI" = 1 ]; then UI_PLAIN_ONLY=/dev/null; else UI_PLAIN_ONLY=/dev/stdout; fi

# ui_banner <title> <subtitle>  ->  a rounded box. Plain: nothing (the old output had no banner).
ui_banner() {
  [ "$UI" = 1 ] || return 0
  local title="$1" sub="$2" w
  w=$(( ${#sub} > ${#title} ? ${#sub} : ${#title} ))
  local rule; rule="$(printf '%*s' $((w + 4)) '' | sed 's/ /─/g')"
  printf '\n  %s╭%s╮%s\n' "$C_C" "$rule" "$C_0"
  printf '  %s│%s  %s%-*s%s  %s│%s\n' "$C_C" "$C_0" "$C_B" "$w" "$title" "$C_0" "$C_C" "$C_0"
  printf '  %s│%s  %s%-*s%s  %s│%s\n' "$C_C" "$C_0" "$C_D" "$w" "$sub" "$C_0" "$C_C" "$C_0"
  printf '  %s╰%s╯%s\n' "$C_C" "$rule" "$C_0"
}

# ui_step <n> <of> <title>  ->  "Step 2 of 4  Installing dependencies". Plain: "== <title>".
ui_step() {
  if [ "$UI" = 1 ]; then printf '\n%s●%s %sStep %s of %s%s  %s%s%s\n' "$C_C" "$C_0" "$C_D" "$1" "$2" "$C_0" "$C_B" "$3" "$C_0"
  else printf '\n== %s\n' "$3"; fi
}

# A line of the step's findings. Plain: the message as it is.
ui_ok()   { if [ "$UI" = 1 ]; then printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; else printf '%s\n' "$1"; fi; }
ui_warn() { if [ "$UI" = 1 ]; then printf '  %s!%s %s\n' "$C_Y" "$C_0" "$1"; else printf '%s\n' "$1"; fi; }
# A dim hint under a finding: indented by four in the plain output too, as those lines always were...
ui_info() { if [ "$UI" = 1 ]; then printf '    %s%s%s\n' "$C_D" "$1" "$C_0"; else printf '    %s\n' "$1"; fi; }
# ... and one that was never indented there (an explanation before a question).
ui_note() { if [ "$UI" = 1 ]; then printf '    %s%s%s\n' "$C_D" "$1" "$C_0"; else printf '%s\n' "$1"; fi; }

# ui_ask <question> <hint> <plain prompt>  ->  the prompt, no newline, for setup.sh's own `read` to
# follow: "? <question> <hint> ›". Plain: <plain prompt>, word for word what it printed before.
ui_ask() {
  if [ "$UI" = 1 ]; then printf '  %s?%s %s%s%s %s%s%s %s›%s ' "$C_C" "$C_0" "$C_B" "$1" "$C_0" "$C_D" "$2" "$C_0" "$C_C" "$C_0"
  else printf '%s' "$3"; fi
}

# ui_answered <label> <value>  ->  replaces the prompt line just answered with "✓ <label> <value>",
# the way a form keeps what you typed. Plain: nothing (the old output did not repeat it).
ui_answered() {
  [ "$UI" = 1 ] || return 0
  printf '\033[1A\033[2K  %s✓%s %s %s%s%s\n' "$C_G" "$C_0" "$1" "$C_B" "$2" "$C_0"
}

# ui_run <label> <command...>  ->  runs the command. With the UI: quietly, a spinner and the seconds it
# has taken, then "✓ <label> (12s)"; if it fails, "✗", the last 25 lines of what it said, and where the
# whole log is - so a failure is never hidden behind the spinner. Plain: the command's own output,
# streamed, as before. Returns the command's exit status either way.
ui_run() {
  local label="$1"; shift
  if [ "$UI" = 0 ]; then "$@"; return; fi
  local log; log="$(mktemp -t parcels-setup)"
  "$@" >"$log" 2>&1 </dev/null &
  local pid=$! start=$SECONDS i=0 rc=0
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  # Ctrl-C mid-step: stop the step too, and give the cursor back.
  trap 'kill "$pid" 2>/dev/null; printf "\033[?25h\n"; exit 130' INT TERM
  printf '\033[?25l'
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r  %s%s%s %s %s%ss%s' "$C_C" "${frames[i % 10]}" "$C_0" "$label" "$C_D" $((SECONDS - start)) "$C_0"
    i=$((i + 1)); sleep 0.1
  done
  wait "$pid" || rc=$?
  trap - INT TERM
  printf '\r\033[2K\033[?25h'
  if [ "$rc" = 0 ]; then
    printf '  %s✓%s %s %s(%ss)%s\n' "$C_G" "$C_0" "$label" "$C_D" $((SECONDS - start)) "$C_0"
    rm -f "$log"
  else
    printf '  %s✗ %s failed%s\n' "$C_R" "$label" "$C_0"
    tail -n 25 "$log" | sed "s/^/    ${C_D}│${C_0} /"
    printf '    %sThe whole log: %s%s\n' "$C_D" "$log" "$C_0"
  fi
  return "$rc"
}

# ui_headline <text> [ok|todo]  ->  the closing line, framed and green (ok) or cyan (still to do).
# Plain: "== <text>", which is what the setup test finds the closing message by.
ui_headline() {
  if [ "$UI" = 0 ]; then printf '\n== %s\n' "$1"; return; fi
  local colour="$C_G" mark='✔'
  [ "${2:-ok}" = ok ] || { colour="$C_C"; mark='➜'; }
  local rule; rule="$(printf '%*s' $(( ${#1} + 6 )) '' | sed 's/ /━/g')"
  printf '\n  %s%s%s\n' "$colour" "$rule" "$C_0"
  printf '  %s%s  %s%s%s\n' "$colour" "$mark" "$C_B" "$1" "$C_0"
  printf '  %s%s%s\n' "$colour" "$rule" "$C_0"
}
