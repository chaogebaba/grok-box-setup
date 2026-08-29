**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/design-conform-config-truth-r1.md
**Artifact-SHA256:** (computed post-write; see callback)
**Artifact-Repo-Path:** tmp/orch/design-conform-config-truth-r1.md
**Git-SHA-fork:** 95e85fe3ad879b99b2655949d2bb378c32acc179

# DESIGN-CONFORMANCE gate — config-truth r1 built diff vs blueprint r4

Gate: post-build conformance. Does `git diff main..95e85fe` (main=43027d6) on
`feat/config-truth` faithfully implement the design-gate-PASSED blueprint r4
(`config-truth.md`, sha 7f459402…)? Reason-only; the working tree was verified
byte-identical at review start and end (`git status --short` empty both times).
Both frozen authority pins VALID at start and immediately before this callback.

Empirical execution of the test suite is NOT mine — I did not run
`make test`; where a claim needs execution I name it for the empirical gate.

---

## VERDICT HEADER

**Result: PASS — design-faithful. Zero-decision buildable: N/A (post-build gate).**

- BLOCKER: 0
- SHOULD: 0
- NIT: 3 (documentation/robustness polish; none block merge)

Every decision D0–D12 is implemented as specified or deviates only where the
blueprint itself authorised it (the post-blueprint render_managed ABSENT-file
fix, D3). The two behaviours the dispatch flagged as must-holds both hold:

1. **A reconcile tick with NO fleet.toml/boxes/ present is a true no-op vs main.**
   `reconcile_config_pass` calls `managed_files_present || return 0` as its first
   statement (fleetctl in-diff: the pass body opens with it). `managed_files_present`
   returns non-zero unless `fleet.toml` exists OR a `boxes/*.toml` exists. So an
   un-managed fleet: no push, no tunnel traffic, no log line — the pass returns 0
   silently and folds a 0 into `rc`. The only new call in `cmd_reconcile` is
   `reconcile_config_pass "$apply" || rc=1`, which is inert here. CONFIRMED no
   behaviour change vs main when D2 files are absent. (Empirical gate: the
   `cp_absent` test asserts exactly this — verify it runs green.)

2. **render_managed handles an ABSENT boxes/<box>.toml (production default) and
   propagates awk failure.** `render_managed` builds an `inputs=()` array with only
   paths that pass `[ -e ]`, never handing awk a non-existent path (which would go
   FATAL, skip END, and silently emit header-only). It drops `2>/dev/null` and the
   `awk … "${inputs[@]}"` exit status is the function's return. `push_managed`
   checks `rrc != 0 → return 4` (no push); `cmd_config diff` checks `rrc != 0 →
   return 2` (refuse). CONFIRMED the post-blueprint fix is present and wired into
   both consumers.

---

## Decision-by-decision

**D0 scope** — IMPLEMENTED. Managed surface = ssh/tailscale/update/managed;
[fleet] and [tailscale].tags EXCLUDED and actively refused by validate_managed.
No tags management, no re-bootstrap, no git-versioning added. Faithful.

**D1 box side + precedence** — IMPLEMENTED.
- `MANAGED_FILE="${BOX_SETUP_MANAGED:-$ROOT/managed.toml}"` constant added
  (boxup), under /workspace, doc comment states mode 600 root + precedence
  env > managed > config > default.
- `config_get_file <file> <table> <key>` is the single awk reader parameterised
  on an explicit path — exactly the "only change to the reader is parameterising
  the path" the blueprint mandates. FIRST-match-per-file preserved (awk unchanged).
- `config_get` two-file precedence: `if en=true AND -f MANAGED_FILE AND key found
  in managed → that value; else config_get_file CONFIG`. Missing managed.toml =
  config-only. Faithful.
- **Hoisted [managed].enabled gate**: `do_ensure_body` sets `MANAGED_ENABLED`
  ONCE per converge (default true) and logs the D8 ignore-notice at most once.
  The `config_get` wrapper adds a LAZY re-read for callers OUTSIDE a converge
  (e.g. `boxup status`, `boxup config-get`) when `MANAGED_ENABLED` is empty — a
  justified, blueprint-consistent addition: the blueprint says "hoist once per
  converge"; the lazy path preserves correctness for non-converge call sites
  without a second hoist. Not a deviation from intent.
- `boxup config-get <table> <key>` read-only subcommand reads LOCAL config.toml
  via config_get_file, exit 1 if absent — exactly D1/D5. Faithful.
- DESIGN.md persistent-layout table gains managed.toml with the "written only by
  the brain; hand edits overwritten" wording. Faithful.

**D2 brain side** — IMPLEMENTED. `FLEET_MANAGED_FLEET`/`FLEET_MANAGED_BOXDIR`
(defaults under `$FLEET_ETC`), `BOX_MANAGED` = on-box path. Both optional; BOTH
absent = silent off (managed_files_present gate). Faithful.

**D3 deterministic render** — IMPLEMENTED incl. the post-blueprint ABSENT-file
fix (see header item 2). `managed_header` is timestamp-free (byte-deterministic).
One awk pass records first-seen (table,key) order + last value, re-emits in
first-seen order with table headers once — matches the "total ordering, box
override replaces value in place, never reorders" spec. `key = value` emitted
verbatim (RHS preserved). No scratch file: text stays in a shell var, fed on
stdin. No-applicable-keys → header only. Awk failure propagated (return status).
Faithful, including the flagged fix.

**D4 refusals + unknown-keys-logged-once** — IMPLEMENTED. `validate_managed`
refuses [fleet], [tailscale].tags, tables outside ssh/tailscale/update/managed,
and unparsable lines; allows unknown-but-well-formed keys. `unknown_managed_keys`
enumerates them; `reconcile_config_pass` declares a run-scoped `local -A
CONFIG_UNKNOWN_KEYS`, push_managed accumulates deduped into it, the pass logs
ONCE at the end. Outside a pass (CLI), push_managed logs once per invocation.
Faithful.

**D5 push_managed seed-idiom fidelity** — IMPLEMENTED, with one JUSTIFIED
transport deviation (documented in-code, not a bug):
- Idiom: spool ALL stdin → sha → compare vs want → mv (or rm on no-op), exit 3
  on mismatch with file untouched, always print ONE status line. All present in
  `managed_remote_script`. Faithful to seed_key_over_tunnel's
  spool→hash→compare→mv shape.
- **Deviation (justified):** the real `seed_key_over_tunnel` (fleetctl:1474+)
  runs `tunnel_ssh "$box" "<script>"` with SINGLE-quoted remote paths and no
  `sudo sh -c` wrapper. push_managed instead wraps in `sudo sh -c '$remote'` and
  the remote script is deliberately single-quote-FREE (sha via `cut`, unquoted
  grep pattern) so it nests inside the outer single-quoted arg. This is a faithful
  adaptation, not a divergence: the seed writes a box-owned path reachable without
  sudo escalation in that context, whereas managed.toml lives in the root-owned
  /workspace tree and needs `sudo`. The idiom (stdin-fed cat, sha-gate, atomic mv)
  is preserved; only the quoting/privilege envelope changed, and the reason is
  stated in-code. (Empirical gate owns: prove `sudo sh -c '<script with no single
  quotes>'` actually round-trips over a live tunnel — the nesting is the one place
  a quoting bug would hide. The `push_test` fake tunnel_ssh strips exactly
  `sudo sh -c '…'`; confirm that mirrors real ssh argv.)
- status line `sha=… support=… enabled=…`; support = `grep -q ^MANAGED_FILE= boxup`;
  enabled read ONLY when support=yes via the box's OWN `boxup config-get` — so
  brain and box never disagree on grammar (quote-stripping is the box's). Brain
  parses order-independent tokens, ignores unknowns, asserts read-back sha ==
  want_sha (return 5 on mismatch). Exit codes 0/3/other → D9. Faithful.

**D6 reconcile_config_pass** — IMPLEMENTED. Inserted EXACTLY between the per-box
loop's `done` and `log "reconcile: done ($mode)"` (verified in the checkout at
the diff's HEAD). Fleet-wide, not a reconcile_decide token. Canary-first
(`reconcile_canary_box`, normalises to grok-box-N; matches reconcile_target_boxes'
full-name output — comparison is consistent), then rest serially. Per-box guard:
`tunnel_up AND no .checkfail` else skip silent. DRY-RUN (apply=0) → --dry-run;
apply=1 → real push. Canary FAILURE → notify warn + abort rest this tick, rc 1;
non-canary failure → D9 bump + continue, rc 1. Folds into cmd_reconcile rc.
DRY-RUN inertness: push_managed --dry-run writes nothing (remote steps 1-3 only,
rm tmp). Faithful. (Design note, NOT a finding: the pass keys off `$apply`, not
`RECONCILE_READONLY`. That latch is the tailscale-API fail-closed guard for
mint/delete/rename; a config push touches no tailscale API, only the SSH tunnel,
so it is a correctly independent subsystem — pushing config during an
API-degraded run is safe. Consistent with the blueprint's D6 wording.)

**D7 operator surface** — IMPLEMENTED. `cmd_config render|diff|push`; all three
refuse un-enrolled boxes via `cmd_config_enrolled` (checks reconcile_target_boxes,
i.e. enrolled.tsv). diff runs the dry-run remote, splits at `---FILE---`, prints
`diff -u on-box vs rendered`, ALWAYS annotates enabled=false / support=no and
never reports in-sync for an ignored file (exit 1 unless cur==want AND enabled!=
false AND support!=no). push = same push_managed as reconcile row-e (one code
path). Registered in dispatch + usage. Faithful.

**D8 escape hatches** — IMPLEMENTED. Brain side: boxes/<box>.toml override (D3
merge). Box side: `[managed] enabled=false` (D1 gate; do_ensure_body logs once
per converge). Both push-log and config diff carry the IGNORED annotation from
the status line. etc/config.example.toml gains the annotated `[managed]` block.
Faithful.

**D9 cfgfail + notify >3 on BOTH paths** — IMPLEMENTED. `reconcile_bump_cfgfail`
(pure: bump + print count) / `reconcile_reset_cfgfail`, same shape as
checkfail/seedfail; notify lives at the CALL SITE (matches seedfail
fleetctl:2402-2404, `-gt 3`). Canary path: on failure `notify warn` fires
UNCONDITIONALLY (abort semantics — the blueprint says canary failure → notify +
abort, which is correct; the ">3" threshold is the non-canary continue path).
Non-canary path: `reconcile_bump_cfgfail` then `[ "$n" -gt 3 ] && notify warn`.
Cleared on next success/in-sync (reconcile_reset_cfgfail called on push success).
Faithful — see NIT-1 on the two notify shapes.

**D10 docs** — IMPLEMENTED. FLEET-BRAIN.md §config-truth: layout, render/merge,
precedence, brain-wins, escape hatches, tags-unsupported, canary flow,
PRECONDITION, operator recipe. DESIGN.md table row. etc/config.example.toml
[managed] comment. New etc/fleet.example.toml documenting D2. Faithful.

**D11 tests** — IMPLEMENTED (coverage present for every decision):
- boxup side (tests/test-boxup-config.sh): managed>config>default, config
  fallback, missing-managed = old behaviour, enabled=false ignore, lazy-gate
  paths, first-match-per-file (managed AND config), config-get local-only + exit 1.
- fleetctl side (tests/test-fleet-brain.sh additions): render merge/order/byte-
  determinism/header-only; P1 ABSENT-file cases (a/b/c/d) + the render-failure→
  push-refuse (d'); D4 refusals + forward-compat allow; D5 write/no-op/dry-run/
  truncated→exit3-unchanged/status annotations; D6 silent-absent/dry-run-order/
  apply-order/canary-abort/non-canary-continue/tunnel+checkfail guards; D4
  once-per-run dedupe; D7 enrolled refuse + diff exit codes + IGNORED; D9
  bump/reset + pure-helper + call-site notify>3.
- Makefile wires test-boxup-config.sh into `make test`.
Coverage maps 1:1 to the D11 list. **NOT verified by me: that the suite actually
passes and the existing 145+59 stay green — that is the empirical gate's ruling.**
The fake-tunnel_ssh stubs are structurally sound (stdin passed through, wrapper
stripped) but their fidelity to real ssh argv is an empirical check (see D5).

**D12 rollout-order note (boxup to all boxes BEFORE fleet.toml)** — IMPLEMENTED
in docs. FLEET-BRAIN.md §config-truth carries an explicit "PRECONDITION (do not
skip)" block AND the same warning in etc/fleet.example.toml's header. D12 proper
(the live-canary empirical procedure) is the empirical gate's to run — not a
diff artifact. The DOC note it requires is present. Faithful.

---

## NITs (polish; none block merge)

- **NIT-1 (D9, fleetctl reconcile_config_pass):** the canary-failure notify fires
  unconditionally on the FIRST failure while the non-canary notify waits for
  count > 3. This is CORRECT per blueprint (canary failure → immediate notify +
  abort; non-canary → threshold), but the asymmetry is easy to misread. A
  one-line comment at the canary notify distinguishing "abort-signal, not a
  threshold" would save a future reader. Smallest amendment: add
  `# canary abort is unconditional (not the >3 threshold — that is the rest-path)`
  above the canary `notify warn`.

- **NIT-2 (D5, managed_remote_script):** `cur=$(sha256sum "$mf" 2>/dev/null | cut
  -d" " -f1)` then `[ -n "$cur" ] || cur=none`. On a box where `sha256sum` exists
  but `$mf` is absent, sha256sum prints nothing to stdout (error to stderr,
  suppressed) → cur empty → cur=none. Correct. But if a future box lacks
  `sha256sum` entirely, the whole remote `set -e` script would have already
  failed at the `got=` line (want-sha step), so this path is unreachable —
  fine, no change needed, noting only that the robustness rests on `set -e`
  catching the missing-binary case early. No amendment required; recorded for
  the empirical gate's awareness.

- **NIT-3 (docs, etc/fleet.example.toml):** the example lists `[managed]` among
  "Managed tables (the boxup config surface)". Pushing `[managed] enabled` from
  the brain is technically in-subset (validate_managed allows it) but semantically
  circular — the brain could push a managed.toml that disables the box's own
  managed layer only if that key were in config.toml, not managed.toml (the gate
  is read from config.toml). No behaviour bug (the gate is a config.toml read, so
  a managed.toml [managed] block is inert for the gate), but the doc could note
  that pushing [managed] via the brain does not toggle the local gate. Smallest
  amendment: one sentence in fleet.example.toml that the box-side gate is
  config.toml-only. Optional.

---

## Attribution (OBSERVED vs JUDGED)

- OBSERVED (read in the diff / checkout @95e85fe): every file:function claim
  above; the D6 insertion point between `done` (loop) and `log "reconcile: done"`;
  seed_key_over_tunnel's single-quoted-path shape (fleetctl:1474+); the seedfail
  call-site notify `-gt 3` (fleetctl:2402-2404); reconcile_canary_box normalising
  to grok-box-N; the boxup awk reader stripping quotes; the clean `git status`
  at start and end.
- JUDGED (my design reasoning): the seed-idiom quoting/privilege deviation is
  justified, not a bug; the RECONCILE_READONLY independence is a correct scope
  boundary; the lazy-gate re-read is intent-consistent; the NITs.
- NOT verified (empirical gate owns): suite pass/fail, existing-suite regression,
  real-ssh argv fidelity of the sudo sh -c nesting, live D12 canary.

**Conformance verdict: PASS.** The built diff faithfully implements blueprint r4
D0–D12. No BLOCKER or SHOULD. Three optional NITs. The one deviation (D5 remote
quoting under sudo) is a justified, in-code-documented adaptation of the seed
idiom, not a departure from the design.
