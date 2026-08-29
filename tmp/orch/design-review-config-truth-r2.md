**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/design-review-config-truth-r2.md
**Artifact-SHA256:** 193c2246549346a652005751d185ece14b37dc69f691cdd1e71a88116ed5e2e2
**Artifact-Repo-Path:** tmp/orch/design-review-config-truth-r2.md
**Git-SHA-root:** 43027d69bf116d08b9caaafaaba01d1e58052563

> Authority pin verified VALID at task start AND immediately before this write
> (`verify_pin` on /data/orchestrator/grok-box-setup/blueprints/config-truth.md -> VALID, v1, both times).
> Working tree byte-identical to baseline: HEAD 43027d6, `git status --short` empty at start and end; only this artifact written under tmp/orch/ (the dispatch-provided CAO_ARTIFACTS_DIR).
> Artifact-SHA256 above is the frozen-pin hash of the reviewed blueprint per the report-header protocol.
> Mode: FULL re-review (not delta-only), per dispatch. Every r1 finding is explicitly re-checked below.

# DESIGN GATE r2 — "VPS brain = source of truth for box config" — VERDICT

**Ruling: FAIL — 1 BLOCKER / 1 SHOULD / 2 NIT.**
**Zero-decision buildable: NO** — one gap remains: D6 names the reconcile insertion point as
"after fleetctl:1804", but :1804 is `return "$rc"` (the function's return statement); inserting
there is unreachable dead code. The builder must be told the pass goes BETWEEN the per-box loop
(`done` at :1802) and the `log "reconcile: done"` / `return` at :1803-1804. Everything else is
buildable: all three r1 BLOCKERs and all four r1 MAJORs are closed, verified against the tree.

**Precedent-first: SATISFIED (verified in-tree).** D5's whole-file-over-tunnel writer now cites
`seed_key_over_tunnel` (fleetctl:1465-1495), which I read line-by-line: it is EXACTLY the
spool-stdin -> `sha256sum` tmp vs `want_sha` (argv) -> mismatch `exit 3` + `rm` -> else `mv -f` +
`chmod 600`, secret on stdin never argv idiom D5 borrows. D6's fleet-wide serial canary-first/abort
pass mirrors `reconcile_rollout` (:2054-2110, read). D9's `.cfgfail` mirrors the verified
`.checkfail`/`.seedfail` counter shape (:2259-2278). D1/D3 awk grammar reuse matches
`_BOX_TOML_AWK`/`config_get` (boxup:214-257, read — first-match-per-file `exit`, `$CONFIG_FILE`
indirection). No reinvented wheels.

## r1 fold verification (each prior finding: closed or not)

| r1 id | r2 fold | status | evidence |
|-------|---------|--------|----------|
| B1 (integration point: row-d is fleet-wide, not per-box; token vs side-effect ambiguous) | D6 | **PARTIALLY CLOSED** | D6 now states it is NOT a `reconcile_decide` token, IS a new fleet-wide pass, and MUST run for in-sync boxes — the ambiguity r1 raised is resolved. But the *exact* insertion line is now wrong (see r2-B1). Confirmed against tree: loop `for b in "${boxes[@]}"` ends `done` at fleetctl:1802; :1803 = `log "reconcile: done ($mode)"`; :1804 = `return "$rc"`. |
| B2 (wrong transport: enroll uses `box_ssh` awk-transform, not `tunnel_ssh` whole-file) | D5 | **CLOSED** | D5 reclassifies as a NEW helper borrowing `seed_key_over_tunnel`'s idiom over `tunnel_ssh`, whole-file, not enroll's transform. Verified: `seed_key_over_tunnel` runs over `tunnel_ssh` (:1476), `tunnel_ssh` uses `$FLEET_BOX_KEY` (:1656). Correct precedent named. |
| B3 (truncated stdin -> silent bad write) | D5 | **CLOSED** | D5: spool ALL stdin to tmp first, hash tmp, compare to `want_sha` on argv, mismatch -> `rm tmp; exit 3`, never installs. Byte-identical safety corner to the verified seed idiom. |
| M1 (tags half-defined / inert) | D0/D4 | **CLOSED** | D0 EXCLUDES `[tailscale].tags` from scope (first-login-only, inert on registered boxes; retag stays manual per config.example.toml:41; revisit Phase 3). D4 REFUSES a tags key in the merge. Clean. |
| M2 (`[managed].enabled` gate order) | D1 | **CLOSED** | D1 hoists `MANAGED_ENABLED` once per converge and gates the managed layer BEFORE it, falling back to today's chain when false. Matches the `ssh_password` env>config precedent (boxup:263-269). (One residual NIT — see r2-N1.) |
| M3 (serial cost understated) | D6 | **CLOSED** | D6 states the pass is serial, canary-first, one extra tunnel round trip per awake box per tick, a slow canary delays the rest — same as rollout, intended, do not parallelize. |
| M4 (diff lies when `enabled=false`) | D5/D7 | **CLOSED** | D5 status line always prints `enabled=<t/f> support=<y/n>`; D7 `config diff` ALWAYS annotates "pushed values IGNORED" for `enabled=false`/`support=no` and never reports in-sync for an ignored file. |
| N1 (render scratch world-readable) | D3 | **CLOSED (stronger)** | D3 removes the scratch file entirely — rendered text lives in a shell variable piped on stdin (`printf '%s\n' "$text" | tunnel_ssh …`), exactly as the seed feeds the key. No file ever holds the password on the VPS. |
| N2 (old boxup ignores file silently) | D5/D10 | **CLOSED** | D5 `support=` probe (`grep -q '^MANAGED_FILE=' boxup`) reports whether the box honours the file; D10 states the PRECONDITION (deploy boxup first) and that the brain detects `support=no` and logs it. |
| N3 (missing tests) | D11 | **CLOSED** | D11 adds truncated-stdin -> exit 3 + file unchanged, status-line parse, and IGNORED-annotation tests for both `enabled=false` and `support=no`. |

**Net:** 3/3 r1 BLOCKERs resolved in substance; the sole residual is a one-line precision defect
in D6's insertion cite (B1's fold introduced a wrong line number). 4/4 r1 MAJORs closed. 3/3 r1
MINORs closed.

## r2 finding table (fold from here)

| id | sev | claim | smallest amendment |
|----|-----|-------|--------------------|
| r2-B1 | BLOCKER | D6: "called in `cmd_reconcile` immediately AFTER the per-box loop (after fleetctl:1804, inside the flock, before the lock is released)". VERIFIED against tree: the per-box loop's `done` is at fleetctl:1802; :1803 is `log "reconcile: done ($mode)"`; :1804 is `return "$rc"`. Inserting "after 1804" is after the function returns — unreachable. A builder following the cite literally either writes dead code or must INVENT the real location. | D6: change the cite to "immediately after the per-box loop's `done` (fleetctl:1802) and BEFORE the closing `log \"reconcile: done ($mode)\"` (:1803) / `return \"$rc\"` (:1804)". Also fix the fold-map line "after fleetctl:1804" to ":1802". State the pass runs while fd 9 flock is still held (it is — the flock is released only when `cmd_reconcile` returns). |
| r2-S1 | SHOULD | Two DIFFERENT readers now parse `[managed].enabled` for the same box: (a) boxup reads it via the awk `config_get_file`/hoisted `MANAGED_ENABLED` (D1); (b) the D5 push script reads it on-box with "a grep of the same grammar" under `sudo sh -s`. The awk reader handles `[table]` scoping, basic/literal strings, and trailing `# comments` (boxup:214-251); a bare `grep` for `enabled` does not scope to the `[managed]` table and mis-handles `enabled = true # note` or an `enabled` key in another table. If the two disagree, the brain's reported `enabled=` (D5 status, drives D7 annotation and D8) diverges from what boxup actually honours — re-opening the M4 class the blueprint just closed. | D5: specify the on-box `enabled` probe as a table-scoped read of the SAME grammar boxup uses (an awk snippet keyed on `want_t=managed want_k=enabled`, or invoke the box's own `boxup` reader over the tunnel), NOT a bare `grep enabled`. One reader definition, cited once, used by both sides. |
| r2-N1 | NIT | D5 status line format `sha=<…> enabled=<…> support=<…>` and the D7 `---FILE---` marker are the wire contract between brain and box, but the blueprint never says the brain parses them positionally/by-key or what happens if a future field is inserted. A brittle positional parse breaks forward-compat (D4 already commits to forward-compat for keys). | D5/D7: state the brain parses the status line by `key=value` tokens (order-independent, unknown tokens ignored), so an added field never breaks an older brain. One sentence. |
| r2-N2 | NIT | D3 renderer emits tables/keys "in first-seen order, last-wins per (table,key)" merging fleet.toml then boxes/<box>.toml — but does not state whether a key that appears in fleet.toml under table A and in boxes/<box>.toml under a DIFFERENT position keeps table A's position or moves. Byte-determinism (D3's goal, drives the sha no-op) requires a total, stated ordering rule for the cross-file case. | D3: state "(table,key) first-seen order is computed over the CONCATENATED fleet-then-box stream; a box override updates the value in place at the key's fleet-first-seen position (does not reorder)". Removes the only ambiguity in the determinism claim. |

## Appendix — reasoning (consult on dispute)

### OBSERVED (read in the tree at HEAD 43027d6)
- `cmd_reconcile` per-box loop: `for b in "${boxes[@]}"; do reconcile_one "$b" "$devs" "$apply" "$RECONCILE_READONLY" || rc=1; done` with `done` at fleetctl:1802, then `log "reconcile: done ($mode)"` :1803, `return "$rc"` :1804. The flock (`exec 9>"$lock"; flock -n 9`) is opened at :1749-1757 and released implicitly on function return — so a pass inserted at :1802-1803 IS inside the flock. This is the single fact behind r2-B1: D6's intent ("inside the flock, before release") is correct; only the line number is wrong.
- `seed_key_over_tunnel` (fleetctl:1465-1495): `want_sha="$(printf '%s\n' "$key" | sha256sum | awk '{print $1}')"`; `printf '%s\n' "$key" | tunnel_ssh "$box" "set -e; umask 077; cat > TMP; got=$(sha256sum TMP); [ got != want_sha ] && { echo SEED_SHA_MISMATCH >&2; rm TMP; exit 3; }; mv -f TMP DST; chmod 600 DST"`. This is D5's borrowed idiom verbatim in shape; D5's `want_sha` on argv + text on stdin + spool-then-hash + exit 3 is a faithful copy. Confirms B2/B3 closed.
- `tunnel_ssh` (fleetctl:1651-1659): `ssh -o BatchMode=yes -o ConnectTimeout=8 -i "$FLEET_BOX_KEY" -p PORT box@127.0.0.1 "$@"` — brain's own key, sudo lives in the caller's command string. Matches D5's transport.
- `reconcile_rollout` (fleetctl:2054-2110): stage tree, canary FIRST via `reconcile_canary_box`, unreachable/failed canary -> `notify warn` + ABORT (zero others), then `rest` serially, tunnel-down box -> skip-continue, verified-failure -> abort-break. D6's shape claim is accurate; the per-box guard "tunnel_up AND no .checkfail else skip" is consistent with rollout's `tunnel_up` skip.
- `reconcile_one` (fleetctl:~1945-1988): dry-run/apply gate is CENTRALIZED here (`[ "$apply" != 1 ] -> log "WOULD $a"; continue`, :1960). D6 correctly does NOT route the config pass through this gate — the pass is separate (like rollout) and does its own `--dry-run`/`--apply` branch, so no double-gating. Coherent.
- `_BOX_TOML_AWK` / `config_get` (boxup:214-257): awk with `-v want_t -v want_k`, `[table]` scoping, basic (`"`)/literal (`'`) strings, `#` comment stripping, first-match `exit`, `END{exit(found?0:1)}`; `config_get` reads `$CONFIG_FILE` (`${BOX_SETUP_CONFIG:-$ROOT/config.toml}`). D1's "parameterise the path into `config_get_file <file> <table> <key>`, `config_get` calls it, first-match-per-file unchanged" is a minimal, faithful refactor. This same read confirms r2-S1: the awk reader is table-scoped and comment-aware; a bare on-box `grep` for `enabled` is not.
- `ssh_password` (boxup:259-269): `BOX_SSH_PASSWORD env > config_get ssh password > default` — the exact env>config>default shape D1's precedence mirrors.
- `.checkfail`/`.seedfail` counters (fleetctl:2259-2278): epoch/count files under `$FLEET_STATE`, bump increments+writes, reset writes 0, `notify warn` when count>3 (seedfail :1975-1978). D9's `.cfgfail` is a faithful clone.

### JUDGED (design reasoning)
- r2-B1 is the only true zero-decision blocker left, and it is narrow: the DESIGN is right (fleet-wide pass, inside flock, after the per-box loop, runs for in-sync boxes) — the blueprint's own prose says exactly that — but the *line-number cite* the fold introduced (":1804") points at the `return`, so a literal builder is handed an unreachable location. It is a one-token amendment (:1804 -> :1802 boundary), but it is load-bearing enough to invent a location, so it gates. This is the residue of B1's otherwise-good fold, not a new architectural miss.
- r2-S1 is the one genuinely new coherence risk r2 introduced by splitting the `enabled` read across two engines. r1's M2/M4 were about ORDER and REPORTING; r2 fixed both, but the fix put a second, weaker reader (on-box `grep`) in the D5 push script. If it under-scopes, the brain's `enabled=` telemetry (which now drives the whole IGNORED-annotation story) can lie in the opposite direction from what boxup honours. Cheap to close: one reader grammar, used by both sides.
- r2-N1/N2 are forward-compat/determinism hardening. N2 matters because D5's no-op path is a sha equality test — if the renderer is not byte-deterministic across the cross-file merge case, an in-sync box can show perpetual drift. The rule is almost stated; one sentence removes the ambiguity.
- Invariant safety: unchanged from r1 and still sound — managed.toml as a separate /workspace file preserves "config.toml is the user's", D4's refusal wall keeps `[fleet]`/tags out, D3's no-scratch render keeps the password off the VPS disk. D12's live-canary gate (deploy branch boxup to canary only, behaviour-neutral repo value, exercise render/diff/push/reconcile, then restore + sha-verify pre-canary state) is well-specified and correctly the empirical lane's job, not mine.

**Zero-decision buildable: NO** — resolve r2-B1 (D6 insertion cite :1804 -> the :1802 `done` / :1803-1804 boundary). Fold r2-S1 (single `[managed].enabled` reader grammar) before the empirical gate or record a skip rationale; r2-N1/N2 are one-sentence hardening. All ten r1 findings are substantively closed.
