#!/usr/bin/env bash
# apply-flip.sh — the binding soak check for `make ts-apply-flip` (I1/H4/I3).
#
# Args: <soak_since> <force> <marker_path> <dropin_path> <dropin_dir> <wrapper_exec>
#
# Verifies a TRAILING window over `journalctl -u fleet-reconcile`:
#   - >= ceil(0.69 * window_seconds/300) `reconcile: done (DRY-RUN)` lines (I3);
#   - ZERO non-zero ExecMainStatus / Result=exit-code runs in the window.
# On PASS: write the marker (attestation) and install the WRAPPER drop-in.
# On FAIL: REFUSE (rc 1), write NO marker, print observed-vs-required + the failed
#   run timestamps — UNLESS FORCE=1, which overrides and records the override INTO
#   the marker (forced=1 observed=N required=M failed_runs=… at=ISO).
# SOAK_SINCE may only LENGTHEN the window (>= 24h); a shorter value is refused.
set -u

since="${1:--24h}"
force="${2:-}"
marker="${3:?marker path}"
dropin="${4:?dropin path}"
dropin_dir="${5:?dropin dir}"
wrapper_exec="${6:?wrapper ExecStart}"

# Window seconds from `since` (accept -Nh / -Nd; default 24h).
window_secs=86400
if [[ "$since" =~ ^-([0-9]+)h$ ]]; then window_secs=$(( ${BASH_REMATCH[1]} * 3600 )); fi
if [[ "$since" =~ ^-([0-9]+)d$ ]]; then window_secs=$(( ${BASH_REMATCH[1]} * 86400 )); fi

# I3: SOAK_SINCE may only LENGTHEN beyond 24h.
if [ "$window_secs" -lt 86400 ]; then
  echo "ts-apply-flip: REFUSED — SOAK_SINCE must be >= 24h (got ${window_secs}s); it may only lengthen the window" >&2
  exit 1
fi

expected=$(( window_secs / 300 ))
# required = ceil(0.69 * expected)
required=$(( (69 * expected + 99) / 100 ))

done_count=0
fail_runs=""
if command -v journalctl >/dev/null 2>&1; then
  done_count="$(journalctl -u fleet-reconcile --since "$since" 2>/dev/null | grep -c 'reconcile: done (DRY-RUN)' || echo 0)"
  # any non-zero ExecMainStatus / Result=exit-code in the window
  fail_runs="$(journalctl -u fleet-reconcile --since "$since" 2>/dev/null \
    | grep -E 'Result=exit-code|ExecMainStatus=[1-9]' | awk '{print $1"T"$2"Z"}' | paste -sd, - || true)"
else
  echo "ts-apply-flip: journalctl not available — cannot verify soak" >&2
fi

now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ok=1
[ "$done_count" -ge "$required" ] 2>/dev/null || ok=0
[ -z "$fail_runs" ] || ok=0

install_wrapper() {
  mkdir -p "$dropin_dir"
  printf '%s\n' '[Service]' 'ExecStart=' "$wrapper_exec" > "$dropin"
}

if [ "$ok" = 1 ]; then
  printf 'observed=%s required=%s at=%s\n' "$done_count" "$required" "$now_iso" > "$marker"
  install_wrapper
  echo "ts-apply-flip: soak PASS (observed=$done_count required=$required); marker written, WRAPPER drop-in installed"
  exit 0
fi

if [ "$force" = 1 ]; then
  printf 'forced=1 observed=%s required=%s failed_runs=%s at=%s\n' "$done_count" "$required" "$fail_runs" "$now_iso" > "$marker"
  install_wrapper
  echo "ts-apply-flip: soak FAILED but FORCE=1 — override recorded in the marker (observed=$done_count required=$required failed_runs=[$fail_runs]); WRAPPER drop-in installed"
  exit 0
fi

echo "ts-apply-flip: REFUSED — soak check failed: observed=$done_count required=$required failed_runs=[$fail_runs]. Re-run after a clean trailing window, or FORCE=1 to override (recorded in the marker)." >&2
exit 1
