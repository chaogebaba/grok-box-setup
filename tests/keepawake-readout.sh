#!/bin/bash
# keepawake-readout.sh — turn a directory of pulled box logs into the ONE table
# that decides whether the keep-awake mechanism stays (blueprint boxup-keepawake
# acceptance 3). Lives in tests/ because it is gate tooling, not box code: it
# never runs on a box and boxup never calls it.
#
#   bash tests/keepawake-readout.sh <dir> [--interval-min N]
#
# <dir> holds one subdirectory per box:
#
#   <dir>/<box>/boxup-keepawake.log   REQUIRED — pulled from /workspace
#   <dir>/<box>/tailscaled.log        optional — the `time jump detected` source
#   <dir>/<box>/install               optional — slot origin, epoch seconds or
#                                     an ISO timestamp. Default: the first
#                                     attempt line's timestamp.
#   <dir>/<box>/off-days              optional — one YYYY-MM-DD per line, or the
#                                     single word `all`. Days on which
#                                     `keepawake=off` was configured; they can
#                                     only be known from outside the attempt log
#                                     (an off box writes no attempt lines, which
#                                     is indistinguishable from a box that was
#                                     asleep), so the operator records them here
#                                     from the `keepawake=` status token.
#
# WHY SLOTS AND NOT LINES. The box's window is split into interval_min slots
# from its own install time. A slot the box was AWAKE for carries an attempt
# line; a slot it was PAUSED for carries nothing, because a paused box does not
# run. So the denominator has to be slot-shaped: a day with forty successful
# fires and thirty-two absent slots is a day the mechanism ran and the box slept
# anyway — the most abandon-ward evidence the experiment can produce — and it
# stays in the denominator. A missing slot contributes to NO count: it is not
# exercised, not busy, and not a defect.
#
# WHEN A SLOT HOLDS SEVERAL LINES (the 90 s unreachable retry floor can put
# three in one slot) the slot takes the BEST outcome in it, by this precedence:
#
#   ok / parked-ok  >  skip  >  inert / refused  >  unreachable
#
# A slot in which the mechanism demonstrably fired IS exercised, whatever the
# failed retries before it were.
#
# DAY CLASSIFICATION is a TOTAL ORDERED function, first match wins. The order is
# load-bearing and swapping any two rules changes the verdict:
#
#   (1) off           the day is listed in off-days
#   (2) defect        inert + refused >= 18 slots  (a quarter of a day at 20 min)
#   (3) exercised     ok + parked-ok  >= 36 slots  (half)
#   (4) activity      skip            >= 36 slots
#   (5) unclassified  anything else — a flaky gateway, moderate load, or a
#                     mostly-missing day
#
# Rule 2 precedes rule 3 on purpose: a day with 20 inert and 52 ok fires is a
# day the mechanism was MISREPORTING itself, and counting it as exercised would
# put a broken measurement in the denominator. Rule 3 precedes rule 4 for the
# mirror reason: 36 real fires is an exercised day even if 36 slots also carried
# platform activity.
#
# Only `exercised` days are in the denominator. A sleep (a `time jump detected`
# line) is attributed to the box-day containing its timestamp and enters the
# numerator only when that day is in the denominator.
set -u

DIR="${1:-}"
shift 2>/dev/null || true
INTERVAL_MIN=20
while [ $# -gt 0 ]; do
  case "$1" in
    --interval-min) INTERVAL_MIN="${2:-20}"; shift 2 ;;
    --interval-min=*) INTERVAL_MIN="${1#*=}"; shift ;;
    *) echo "keepawake-readout: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "usage: bash tests/keepawake-readout.sh <dir> [--interval-min N]" >&2
  exit 2
fi
case "$INTERVAL_MIN" in ''|*[!0-9]*|0) echo "keepawake-readout: --interval-min must be a positive integer" >&2; exit 2 ;; esac
if [ $((1440 % INTERVAL_MIN)) -ne 0 ]; then
  echo "keepawake-readout: --interval-min must divide 1440 (got $INTERVAL_MIN)" >&2
  exit 2
fi

# The control rate the experiment is measured against: probe §6, grok-box-004,
# 8 sleeps in 6 d 22 h = 1 per 20.8 h.
CONTROL_RATE=1.15
# Verdict bands (acceptance 3).
KEEP_MAX=0.3
ABANDON_MIN=0.8
MIN_EXERCISED_DAYS=20
MIN_BOXES=5

ROWS="$(mktemp)"
trap 'rm -f "$ROWS"' EXIT
REFUSED=0

# ---------------------------------------------------------------------------
# One awk pass per box. Emits one row per day:
#   box day ok inert refused skip unreachable parked_ok parked_blocked missing jumps class
# ---------------------------------------------------------------------------
for boxdir in "$DIR"/*/; do
  [ -d "$boxdir" ] || continue
  box="$(basename "$boxdir")"
  log="$boxdir/boxup-keepawake.log"
  [ -f "$log" ] || continue
  tslog="$boxdir/tailscaled.log"; [ -f "$tslog" ] || tslog=/dev/null
  offdays="$boxdir/off-days"; [ -f "$offdays" ] || offdays=/dev/null

  origin=""
  if [ -f "$boxdir/install" ]; then
    origin="$(tr -d '[:space:]' < "$boxdir/install" 2>/dev/null || true)"
    case "$origin" in
      ''|*[!0-9]*) origin="$(date -u -d "$origin" +%s 2>/dev/null || echo "")" ;;
    esac
  fi

  awk -v box="$box" -v interval_min="$INTERVAL_MIN" -v origin="${origin:-}" \
      -v tslog="$tslog" -v offdays="$offdays" '
function floor(x) { return (x >= 0) ? int(x) : -int(-x + 0.999999) }
# days_from_civil / civil_from_days: Howard Hinnants proleptic Gregorian
# algorithms. Used instead of gawks mktime/strftime so the readout runs on
# mawk and busybox awk too — a gate box is not guaranteed to have gawk.
function days_from_civil(y, m, d,   yy, era, yoe, doy, doe, mp) {
  yy = y - (m <= 2 ? 1 : 0)
  era = floor(yy / 400)
  yoe = yy - era * 400
  mp = (m > 2) ? m - 3 : m + 9
  doy = int((153 * mp + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}
function civil_from_days(z,   era, doe, yoe, y, doy, mp, d, m) {
  z += 719468
  era = floor(z / 146097)
  doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400
  doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153)
  d = doy - int((153 * mp + 2) / 5) + 1
  m = (mp < 10) ? mp + 3 : mp - 9
  y += (m <= 2) ? 1 : 0
  return sprintf("%04d-%02d-%02d", y, m, d)
}
function iso2epoch(s,   y, mo, d, h, mi, se) {
  # 2026-09-03T04:20:11Z
  if (s !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) return -1
  y = substr(s, 1, 4) + 0; mo = substr(s, 6, 2) + 0; d = substr(s, 9, 2) + 0
  h = substr(s, 12, 2) + 0; mi = substr(s, 15, 2) + 0; se = substr(s, 18, 2) + 0
  return days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se
}
# rank: the slot-collapse precedence. Higher wins. EVERY one of the guard
# seven rc tokens must appear here — rank 0 means "unknown token", and an
# unknown token is dropped from the slot map, which would silently delete a
# real attempt from the denominator of the experiment. The r1 empirical gate caught
# exactly that: `parked-blocked` was missing, so a day made of parked-blocked
# fires produced no row at all.
#
# `parked-blocked` ranks WITH inert/refused, not with parked-ok: the fire was
# accepted but the idle clock did not move, so the mechanism demonstrably did
# NOT keep the box awake in that slot. It is unexercised evidence.
function rank(rc) {
  if (rc == "ok" || rc == "parked-ok") return 4
  if (rc == "skip") return 3
  if (rc == "inert" || rc == "refused" || rc == "parked-blocked") return 2
  if (rc == "unreachable") return 1
  return 0
}
BEGIN {
  interval_s = interval_min * 60
  slots_per_day = int(86400 / interval_s)
  # off-days
  if (offdays != "/dev/null") {
    while ((getline l < offdays) > 0) {
      gsub(/[ \t\r]/, "", l)
      if (l == "") continue
      if (l == "all") off_all = 1; else offday[l] = 1
    }
    close(offdays)
  }
  min_epoch = -1; max_epoch = -1
}
# --- the attempt log -------------------------------------------------------
# <ISO> rc=<token> before=<ms|-> after=<ms|->
{
  rc = ""; ts = -1
  for (i = 1; i <= NF; i++) {
    if ($i ~ /^rc=/)  rc = substr($i, 4)
    else if (i == 1)  ts = iso2epoch($i)
  }
  if (ts < 0 || rc == "") { malformed++; next }
  if (rank(rc) == 0) { unknown_rc[rc]++; malformed++; next }
  lines++
  if (min_epoch < 0 || ts < min_epoch) min_epoch = ts
  if (ts > max_epoch) max_epoch = ts
  ev_ts[lines] = ts; ev_rc[lines] = rc
}
END {
  if (lines == 0) {
    # Still say so: a log whose every line was unparseable is a measurement
    # defect, and exiting silently makes it look like an empty window.
    if (malformed > 0)
      printf "%s MALFORMED %d lines could not be parsed (no usable attempts)\n", box, malformed > "/dev/stderr"
    exit 0
  }
  # Slot origin: the install time when the operator recorded one, else the
  # first attempt line. The origin only shifts slot BOUNDARIES; it never
  # changes which day a line falls in.
  o = (origin == "") ? min_epoch : origin + 0
  for (n = 1; n <= lines; n++) {
    slot = floor((ev_ts[n] - o) / interval_s)
    key = slot ""
    if (!(key in slot_rc) || rank(ev_rc[n]) > rank(slot_rc[key])) slot_rc[key] = ev_rc[n]
    slot_day[key] = civil_from_days(floor(ev_ts[n] / 86400))
  }
  for (key in slot_rc) {
    d = slot_day[key]
    day_seen[d] = 1
    c[d "|" slot_rc[key]]++
    covered[d]++
  }
  # --- jumps ---------------------------------------------------------------
  # tailscaled writes `2026/09/02 01:09:53 …`; accept an ISO date too.
  if (tslog != "/dev/null") {
    while ((getline l < tslog) > 0) {
      if (l !~ /time jump detected/) continue
      if (match(l, /[0-9][0-9][0-9][0-9][\/-][0-9][0-9][\/-][0-9][0-9]/)) {
        jd = substr(l, RSTART, RLENGTH)
        gsub(/\//, "-", jd)
        jumps[jd]++
        jump_day_seen[jd] = 1
      } else undated_jumps++
    }
    close(tslog)
  }
  # --- enumerate every day from the first to the last observation ----------
  first_day = floor(min_epoch / 86400)
  last_day  = floor(max_epoch / 86400)
  for (dd = first_day; dd <= last_day; dd++) all_day[civil_from_days(dd)] = 1
  for (d in day_seen) all_day[d] = 1
  for (d in jump_day_seen) if (d in day_seen) all_day[d] = 1

  n_out = 0
  for (d in all_day) {
    ok  = c[d "|ok"] + 0
    pok = c[d "|parked-ok"] + 0
    pbl = c[d "|parked-blocked"] + 0
    ine = c[d "|inert"] + 0
    ref = c[d "|refused"] + 0
    ski = c[d "|skip"] + 0
    unr = c[d "|unreachable"] + 0
    cov = covered[d] + 0
    miss = slots_per_day - cov
    if (miss < 0) miss = 0
    # THE ORDERED CLASSIFIER. Do not reorder: (2) before (3) keeps a day whose
    # measurement was broken out of the denominator; (3) before (4) keeps a day
    # with 36 real fires from being written off as mere platform activity.
    # RULE 1, and the one input the readout does not derive itself. `off-days`
    # is operator-supplied, so it is checked against the evidence rather than
    # trusted over it (r1 empirical gate, finding 2): a day the box actually
    # attempted anything on was NOT off, and letting the input win there would
    # let a real box-day — possibly an abandon-ward one — be deleted from the
    # denominator by hand. A conflict is REFUSED, not silently ignored, because
    # an operator who wrote the wrong date must fix the input rather than read a
    # verdict computed around it.
    if ((off_all || (d in offday)) && cov > 0) {
      printf "keepawake-readout: REFUSED off-days for %s %s: the day has %d attempt line(s) (ok=%d skip=%d inert=%d refused=%d unreachable=%d parked-ok=%d parked-blocked=%d), so it was not off for the whole day\n", \
        box, d, cov, ok, ski, ine, ref, unr, pok, pbl > "/dev/stderr"
      conflict = 1
      continue
    }
    if (off_all || (d in offday))              cls = "off"
    else if (ine + ref >= slots_per_day / 4)   cls = "defect"
    else if (ok + pok  >= slots_per_day / 2)   cls = "exercised"
    else if (ski       >= slots_per_day / 2)   cls = "activity"
    else                                       cls = "unclassified"
    printf "%s %s %d %d %d %d %d %d %d %d %d %d %s\n", \
      box, d, slots_per_day, ok, ine, ref, ski, unr, pok, pbl, miss, jumps[d] + 0, cls
    n_out++
  }
  if (malformed > 0) printf "%s MALFORMED %d lines could not be parsed\n", box, malformed > "/dev/stderr"
  if (conflict) exit 3
}
' "$log" >> "$ROWS"
  [ "$?" = 3 ] && REFUSED=1
done

# An off-days conflict aborts the WHOLE run rather than printing a table around
# it: the operator asserted a box-day was off that the box itself recorded
# attempts on, so one of the two is wrong and no verdict computed from that
# mixture is worth reading. The awk pass already named the offending day and its
# counts on stderr.
if [ "$REFUSED" = 1 ]; then
  echo "keepawake-readout: no table and no verdict — fix the off-days input(s) named above and re-run" >&2
  exit 3
fi

sort -k1,1 -k2,2 -o "$ROWS" "$ROWS"

printf '%-16s %-12s %6s %5s %6s %8s %5s %8s %10s %15s %8s %6s %s\n' \
  box day slots ok inert refused skip unreach parked-ok parked-blocked missing jumps class
while read -r b d sl ok ine ref ski unr pok pbl miss ju cls; do
  [ -n "${b:-}" ] || continue
  printf '%-16s %-12s %6s %5s %6s %8s %5s %8s %10s %15s %8s %6s %s\n' \
    "$b" "$d" "$sl" "$ok" "$ine" "$ref" "$ski" "$unr" "$pok" "$pbl" "$miss" "$ju" "$cls"
done < "$ROWS"

echo
awk -v control="$CONTROL_RATE" -v keep_max="$KEEP_MAX" -v abandon_min="$ABANDON_MIN" \
    -v min_days="$MIN_EXERCISED_DAYS" -v min_boxes="$MIN_BOXES" '
{
  cls = $13
  n[cls]++
  if (cls == "exercised") { ex++; exbox[$1] = 1; jumps += $12 }
}
END {
  nb = 0; for (b in exbox) nb++
  printf "exercised box-days: %d  (boxes: %d)\n", ex + 0, nb
  printf "other days: activity=%d defect=%d unclassified=%d off=%d  (reported, never in the denominator)\n", \
    n["activity"] + 0, n["defect"] + 0, n["unclassified"] + 0, n["off"] + 0
  printf "jumps in exercised days: %d\n", jumps + 0
  if (ex + 0 == 0) { rate = -1; printf "rate: n/a\n" }
  else { rate = (jumps + 0) / ex; printf "rate: %.2f sleeps per exercised box-day  (control %.2f)\n", rate, control }
  if (ex + 0 < min_days || nb < min_boxes) {
    printf "verdict: INSUFFICIENT — need >= %d exercised box-days across >= %d boxes; EXTEND the window before any verdict\n", min_days, min_boxes
    exit 0
  }
  if (rate <= keep_max)        printf "verdict: KEEP  (rate %.2f <= %.2f)\n", rate, keep_max
  else if (rate >= abandon_min) printf "verdict: ABANDON — set [keepawake] interval_min = 0 fleet-wide  (rate %.2f >= %.2f)\n", rate, abandon_min
  else                          printf "verdict: INCONCLUSIVE — extend by 48 h ONCE  (%.2f < rate %.2f < %.2f)\n", keep_max, rate, abandon_min
}
' "$ROWS"
