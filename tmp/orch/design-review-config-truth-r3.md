**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/design-review-config-truth-r3.md
**Artifact-SHA256:** 97cf3b45e0922fd5bc13e32f49e33fa759bb81d1d9f9a122a61e4141c67d0e54
**Artifact-Repo-Path:** tmp/orch/design-review-config-truth-r3.md
**Git-SHA-root:** 43027d69bf116d08b9caaafaaba01d1e58052563

> Authority pin verified VALID at task start AND immediately before this write
> (`verify_pin` on /data/orchestrator/grok-box-setup/blueprints/config-truth.md -> VALID, v1).
> Working tree byte-identical to baseline: HEAD 43027d6, `git status --short` empty at start and end;
> only this artifact written under tmp/orch/ (the dispatch-provided CAO_ARTIFACTS_DIR).
> Artifact-SHA256 above is the frozen-pin hash of the reviewed blueprint per the report-header protocol.
> Mode: FULL re-review (not delta-only), per dispatch. Every r2 finding is explicitly re-checked; r1
> closures re-confirmed not regressed. All line numbers below re-grounded by fresh grep against the
> live tree at HEAD 43027d6 (NOT trusted from the r2 memo — see r3-B1).

# DESIGN GATE r3 — "VPS brain = source of truth for box config" — VERDICT

**Ruling: FAIL — 1 BLOCKER / 0 SHOULD / 1 NIT.**
**Zero-decision buildable: NO** — the D6 reconcile insertion point is STILL mis-cited. r2-B1's
fold renumbered the cite (":1804 return" -> ":1802 done") but did not re-ground it against the
tree: at HEAD 43027d6, :1802 is the `for` (loop opener), :1804 is the `done` (loop close), :1805
is the `log`, :1806 is the `return`. Every parenthetical in D6 is off by two AND mislabeled. The
D6 PROSE intent is now correct and unambiguous ("after the loop's `done`, before the closing
log/return, flock still held") — a builder reading the words lands right; a builder trusting the
NUMBERS inserts inside the per-box loop body (:1802 "done" is actually `for`), which runs per-box
and contradicts D6's own "must run for in-sync boxes too". Prose contradicts cite at the single
load-bearing integration point. One-token class of defect, but load-bearing → gates.

**Everything else is buildable.** r2-S1 CLOSED (verified strong), r2-N1 CLOSED, r2-N2 CLOSED. All
three r1 BLOCKERs and four r1 MAJORs remain closed; nothing r1 closed has regressed.

**Precedent-first: SATISFIED (re-verified in-tree).** D5 whole-file-over-tunnel writer cites
`seed_key_over_tunnel` (fleetctl:1465-1495, read line-by-line): spool stdin -> `sha256sum` tmp vs
`want_sha` (argv) -> mismatch `exit 3` + `rm` -> else `mv -f` + `chmod 600`, secret on stdin never
argv — D5's borrowed idiom verbatim in shape. D6 fleet-wide serial canary-first/abort pass mirrors
`reconcile_rollout` (fleetctl:2054-2110, read): unreachable/failed canary -> `notify warn` + ABORT
zero others, then rest serially, tunnel-down -> skip-continue, verified-failure -> abort-break. D9
`.cfgfail` mirrors `.checkfail`/`.seedfail` counter shape (fleetctl:2259-2278, read). D1/D5 reader
reuse matches `_BOX_TOML_AWK`/`config_get` (boxup:214-257, read — table-scoped, comment-aware,
first-match-per-file `exit`). No reinvented wheels.

## r2 fold verification (each prior finding: closed or not)

| r2 id | r3 fold | status | evidence |
|-------|---------|--------|----------|
| r2-B1 (D6 insertion cite ":1804" points at `return` = unreachable) | D6 | **NOT CLOSED (renumbered, still wrong)** | r3 D6 now cites `done (:1802)` / `log (:1803)` / `return (:1804)`. Fresh grep at HEAD 43027d6: `for b in "${boxes[@]}"; do` = **:1802**, `reconcile_one` = :1803, `done` = **:1804**, `log "reconcile: done ($mode)"` = **:1805**, `return "$rc"` = **:1806**. So r3 mislabels :1802 (the `for`) as the `done`, and its whole triple is shifted -2. "After :1802" = inside the loop body. See r3-B1. NOTE: the r2 memo's OWN OBSERVED cite (`done`=:1802) was already wrong by two against this same commit; r3 folded the bad numbers forward. |
| r2-S1 (two different readers parse `[managed].enabled`; on-box bare `grep` under-scopes) | D5 | **CLOSED (strong)** | D5 now reads `enabled` ONLY via the box's own reader — new read-only `boxup config-get <table> <key>` (D1) invoking `config_get_file`. Verified boxup:214-257: `_BOX_TOML_AWK` is table-scoped (`sec != want_t` -> skip) and comment-aware (`h = index(v,"#")`), handles basic/literal strings. Delegating to boxup's own reader means brain and box CANNOT disagree on grammar. The M4-reopen risk r2-S1 raised is removed. |
| r2-N1 (status-line / `---FILE---` wire contract parse unspecified) | D5/D7 | **CLOSED** | D5: "brain parses the status line as order-independent `key=value` tokens, ignoring unknown tokens (an added field never breaks an older brain)". D7 status line still parsed by key=value even with the `---FILE---` marker. Forward-compat stated. |
| r2-N2 (cross-file merge ordering not total -> byte-determinism unproven) | D3 | **CLOSED** | D3: "(table,key) order = first-seen order over the CONCATENATED fleet-then-box stream, and a box override replaces the VALUE in place at the key's first-seen position (never reorders) — a total ordering, so identical inputs give identical bytes". The determinism claim (which the D5 sha no-op path depends on) is now grounded in a total rule. |

**Net:** r2-S1, r2-N1, r2-N2 substantively closed. r2-B1 NOT closed — the fold changed the cite
but introduced a fresh -2 misalignment; the design INTENT is correct, the LINE NUMBERS are not.

## r1 non-regression (spot re-confirm)
r1-B1 (integration point ambiguity) — D6 still declares NOT-a-token / fleet-wide / runs-for-in-sync:
intact. r1-B2 (transport) — D5 still `tunnel_ssh` + seed idiom, not enroll's `box_ssh` transform:
intact. r1-B3 (truncated stdin) — D5 spool-then-hash-vs-want_sha, exit 3, never installs: intact.
r1-M1 (tags) — D0 EXCLUDES tags, D4 REFUSES a tags key: intact. r1-M2/M4 (enabled gate + diff
honesty) — D1 hoists `MANAGED_ENABLED`, D5/D7 always print+annotate: intact and hardened by S1
fold. r1-N1 (scratch file) — D3 no-scratch, text in shell var piped on stdin: intact. Nothing r1
closed has regressed.

## r3 finding table (fold from here)

| id | sev | claim | smallest amendment |
|----|-----|-------|--------------------|
| r3-B1 | BLOCKER | D6 (and the r2->r3 fold-map line) cite the reconcile insertion point as `done` (fleetctl:1802) / `log` (:1803) / `return` (:1804). Fresh grep at HEAD 43027d6 (unambiguous): :1802 = `for b in "${boxes[@]}"; do`; :1803 = `reconcile_one ...`; :1804 = `done`; :1805 = `log "reconcile: done ($mode)"`; :1806 = `return "$rc"`. The triple is shifted -2 and mislabeled — :1802 is the loop OPENER, not `done`. A builder trusting the numbers inserts "after :1802" = INSIDE the per-box loop body, running the config pass once per box, which directly violates D6's own "must run for in-sync boxes too / NOT a `reconcile_decide` token". The prose is right; the cite is wrong; they contradict at the one load-bearing seam. | D6: correct the cite to "immediately after the per-box loop's `done` (fleetctl:**:1804**) and BEFORE the closing `log \"reconcile: done ($mode)\"` (**:1805**) / `return \"$rc\"` (**:1806**)". Fix the fold-map line "insertion cite :1802/:1803" to ":1804/:1805". Keep the (correct) prose "fd-9 flock still held there (released only when cmd_reconcile returns)". |
| r3-N1 | NIT | The r2->r3 and r1->r2 fold maps embed line-number cites (e.g. "insertion cite :1802/:1803") that are now stale/wrong (r3-B1). A fold map is durable provenance a future re-gate trusts; a wrong number here re-seeds the same defect (it already did, r2->r3). | After fixing r3-B1, correct the fold-map's ":1802/:1803" to the true ":1804/:1805". One-token edit; prevents the next fold from re-inheriting the error. |

## Appendix — reasoning (consult on dispute)

### OBSERVED (read in the tree at HEAD 43027d6; git status --short empty)
- `cmd_reconcile` tail, grep-confirmed line numbers: `:1801 local rc=0`; `:1802 for b in "${boxes[@]}"; do`; `:1803 reconcile_one "$b" "$devs" "$apply" "$RECONCILE_READONLY" || rc=1`; `:1804 done`; `:1805 log "reconcile: done ($mode)"`; `:1806 return "$rc"`; `:1807 }`. The fd-9 flock is opened at :1750-1757 (`exec 9>"$lock"` in a brace group, then `flock -n 9`) and released implicitly on function return — so a pass inserted between :1804 and :1805 IS inside the flock. D6's INTENT ("after the loop's done, before the closing log/return, flock still held") is exactly correct; only the parenthetical numbers are wrong (the sole basis of r3-B1). HEAD is byte-identical to the commit r2 reviewed (clean tree, same 43027d6), so no line shifted between rounds — the r2 memo's own `done=:1802` cite was already off by two, and r3 folded it forward unchanged.
- `seed_key_over_tunnel` (fleetctl:1465-1495): `want_sha="$(printf '%s\n' "$key" | sha256sum | awk '{print $1}')"`; over `tunnel_ssh`: `set -e; umask 077; cat > TMP; got=$(sha256sum TMP); [ got != want_sha ] -> echo SEED_SHA_MISMATCH >&2; rm -f TMP; exit 3; else mv -f TMP DST; chmod 600 DST`. D5's want_sha-on-argv + text-on-stdin + spool-then-hash + exit 3 + mv/chmod is a faithful shape copy. Confirms D5 precedent + r1-B2/B3 still closed.
- `_BOX_TOML_AWK` / `config_get` (boxup:214-257): awk `-v want_t -v want_k`, `[table]` scoping via `sec != want_t -> skip`, basic(`"`)/literal(`'`) strings, `#` comment strip (`h=index(v,"#")`), first-match `exit`, `END{exit(found?0:1)}`; `config_get` reads `$CONFIG_FILE`. D1's "parameterise the path into `config_get_file <file> <table> <key>`; new read-only `boxup config-get`" is a minimal faithful refactor. This SAME read is the evidence r2-S1 is closed: because D5 now delegates the on-box `enabled` read to THIS reader (via `boxup config-get`), not a bare `grep`, brain and box share one table-scoped comment-aware grammar.
- `ssh_password` (boxup:259-278): `BOX_SSH_PASSWORD env > config_get ssh password > DEFAULT_SSH_PASSWORD` — the env>config>default precedent D1's precedence mirrors.
- `reconcile_rollout` (fleetctl:2054-2110): canary via `reconcile_canary_box`; unreachable canary -> `notify warn` + ABORT (cleanup, zero others); failed canary verify -> same; then `rest` serially: tunnel-down -> skip-continue, verified-failure -> `notify warn` + `rc=1` + break. D6's "canary first, abort rest on canary failure, non-canary failure continues, tunnel-down/checkfail skip" mirrors this shape accurately.
- `.checkfail`/`.seedfail` counters (fleetctl:2259-2278): epoch/count files under `$FLEET_STATE`, bump increments+writes, reset writes 0. D9's `.cfgfail` clone (+ `notify warn` at >3, like seedfail) is faithful.

### JUDGED (design reasoning)
- r3-B1 is the only zero-decision blocker, and it is the SAME class as r2-B1: a wrong line-number cite at the D6 insertion seam. The fold "fixed" it by moving the number, but moved it to a number that is ALSO wrong (and now points at the loop opener rather than the return), so the defect survived the round. The design is right in prose — the reader can even self-correct from the prose — but a DESIGN gate's zero-decision bar is that a literal builder invents nothing; here a literal builder trusting the cite inserts inside the loop and produces the per-box behaviour D6 explicitly forbids. That is invent-a-location territory, so it gates rather than dropping to SHOULD. The amendment is a two-token renumber (:1802/:1803/:1804 -> :1804/:1805/:1806) plus the mirroring fold-map line (r3-N1); trivial to close, but it must be closed before the empirical gate spends a live-canary tick on a blueprint whose one integration cite is self-contradictory.
- r2-S1 is the substantive win of this round: routing the on-box `enabled` probe through `boxup config-get` (the box's own reader) collapses the two-reader divergence risk to zero and is the correct precedent-first move (reuse the shipped grammar, don't hand-roll a grep). Verified against the awk. This also strengthens the M4 closure it threatened.
- r2-N1 (key=value token parse) and r2-N2 (total cross-file ordering) are both closed with the exact one-sentence hardening the r2 memo drafted; N2 in particular is load-bearing for D5's sha no-op path (a non-deterministic render would show perpetual drift) and is now a stated total order.
- Invariant safety unchanged and sound: managed.toml as a separate /workspace file preserves "config.toml is the user's"; D4's refusal wall keeps `[fleet]`/tags out of the merge; D3's no-scratch render keeps `[ssh].password` off VPS disk; D5's spool-then-verify keeps a truncated stream from ever installing. D12's live-canary gate (branch boxup to canary only, behaviour-neutral repo value, exercise render/diff/push/reconcile, then restore + sha-verify pre-canary state) is well-specified and correctly the EMPIRICAL lane's job — not mine; I neither ran nor simulated it.

**Zero-decision buildable: NO** — resolve r3-B1 (D6 cite :1802/:1803/:1804 -> the true :1804 `done` / :1805 `log` / :1806 `return`) and the mirroring fold-map line (r3-N1). r2-S1/N1/N2 are closed; all r1 findings remain closed. Once D6's cite matches the tree, this blueprint is buildable.
