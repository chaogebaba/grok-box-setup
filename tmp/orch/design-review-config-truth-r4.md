**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/design-review-config-truth-r4.md
**Artifact-SHA256:** 7f4594027495f85c0bb56386a36f94b9383e32f36f7556f6810d373a811d4f2b
**Artifact-Repo-Path:** tmp/orch/design-review-config-truth-r4.md
**Git-SHA-root:** 43027d69bf116d08b9caaafaaba01d1e58052563

> Authority pin verified VALID at task start AND immediately before this write
> (`verify_pin` on /data/orchestrator/grok-box-setup/blueprints/config-truth.md -> VALID, v1).
> Working tree byte-identical to baseline: HEAD 43027d6, `git status --short` empty at start and end;
> only this artifact written under tmp/orch/ (the dispatch-provided CAO_ARTIFACTS_DIR).
> Artifact-SHA256 above is the frozen-pin hash of the reviewed blueprint per the report-header protocol.
> Mode: FULL re-review (not delta-only), per dispatch. r3-B1/r3-N1 explicitly re-checked; r1/r2 closures
> re-confirmed not regressed. All line numbers below re-grounded by fresh grep against the live tree at
> HEAD 43027d6 (NOT trusted from the r3 memo or the blueprint).

# DESIGN GATE r4 — "VPS brain = source of truth for box config" — VERDICT

**Ruling: PASS — 0 BLOCKER / 0 MAJOR / 1 MINOR.**
**Zero-decision buildable: YES.**

r3-B1 CLOSED and r3-N1 CLOSED. The r4 re-grounding of the D6 insertion cite is CORRECT against the
tree and now additionally text-anchored. Nothing r1/r2/r3 closed has regressed. The single MINOR
(r4-N1) is a false provenance token — a `fleetctl sha 8fcf1dc1…` in D6 that resolves to nothing in
the repo — that does NOT affect buildability (the line numbers are right AND text-anchored) but should
be corrected so a future fold does not inherit a bogus provenance claim, which is precisely the
fold-forward failure mode that produced r2-B1 -> r3-B1.

**Precedent-first: SATISFIED (re-verified in-tree).** All borrowed idioms still anchor to real,
shipped code at the cited lines: D5 whole-file-over-tunnel writer = `seed_key_over_tunnel`
(fleetctl:1465-1495; `want_sha` :1467, `SEED_SHA_MISMATCH`/`exit 3` :1474, spool-then-hash-then-mv);
D6 fleet-wide serial canary-first/abort pass = `reconcile_rollout` (fleetctl:2054-2110); D9 `.cfgfail`
counter = `.checkfail`/`.seedfail` shape (fleetctl:2259-2278, `notify warn` at >3 like seedfail :1977);
D1/D5 reader reuse = `_BOX_TOML_AWK`/`config_get` (boxup:214-257, table-scoped, comment-aware,
first-match-per-file). No reinvented wheels.

## r3 fold verification (each prior finding: closed or not)

| r3 id | r4 fold | status | evidence |
|-------|---------|--------|----------|
| r3-B1 (D6 insertion cite off by -2: cited `done`:1802/`log`:1803/`return`:1804; true `done`:1804/`log`:1805/`return`:1806) | D6 | **CLOSED** | r4 D6 now cites `for`:1802, `reconcile_one`:1803, `done`:1804, `log`:1805, `return`:1806; insert between :1804 and :1805. Fresh grep @43027d6 (unambiguous): `:1802 for b in "${boxes[@]}"; do`, `:1803 reconcile_one "$b" …`, `:1804 done`, `:1805 log "reconcile: done ($mode)"`, `:1806 return "$rc"`. EXACT match. Also hardened: "match by the quoted line text if numbers drift" — text-anchored, so a literal builder lands right even under future drift. |
| r3-N1 (fold-map embedded stale cite ":1802/:1803") | D6 fold-map | **CLOSED** | r3->r4 fold-map line reads "for :1802, done :1804, log :1805, return :1806; insert between :1804 and :1805; text-anchored". Matches the tree. The mirror no longer re-seeds a wrong number. |

**Net:** both r3 findings substantively closed. The class of defect (a wrong line-number cite at the D6
seam) that survived r1->r2->r3 is resolved in r4 and future-proofed by the text anchor.

## r1/r2 non-regression (re-confirmed against the tree)
- r1-B1 (integration-point ambiguity) — D6 still declares NOT-a-token / fleet-wide / runs-for-in-sync,
  now with a correct+text-anchored seam. Intact and improved.
- r1-B2 / r2-B1-lineage (transport) — D5 still `tunnel_ssh` + `seed_key_over_tunnel` idiom (fleetctl:1465-1495,
  :1651-1659 for tunnel_ssh), not enroll's `box_ssh` transform. Intact.
- r1-B3 (truncated stdin) — D5 spool-then-hash-vs-want_sha, `exit 3`, never installs. Intact (`want_sha`
  :1467 / mismatch->exit 3 :1474 confirm the borrowed shape).
- r1-M1 (tags) — D0 EXCLUDES [tailscale].tags; D4 REFUSES a tags key. Intact.
- r1-M2/M4 (enabled gate + diff honesty) — D1 hoists `MANAGED_ENABLED`; D5/D7 always print+annotate the
  IGNORED status. Intact.
- r1-N1 (scratch file) — D3 no-scratch, text in a shell var piped on stdin. Intact.
- r2-S1 (two readers for `[managed].enabled`) — D5 reads `enabled` ONLY via the box's own reader
  (`boxup config-get` -> `config_get_file`, boxup:214-257). Intact (strong).
- r2-N1 (status-line/`---FILE---` wire contract) — D5/D7 parse order-independent key=value tokens,
  ignore unknown. Intact.
- r2-N2 (total cross-file merge ordering -> byte determinism) — D3 first-seen-over-concatenated-stream,
  value-replaced-in-place, total order. Intact (load-bearing for D5's sha no-op path).

Nothing that r1/r2/r3 closed has regressed.

## r4 finding table (fold from here)

| id | sev | claim | smallest amendment |
|----|-----|-------|--------------------|
| r4-N1 | MINOR | D6 introduces a provenance token `grounded @ main 43027d6 (fleetctl sha 8fcf1dc1…)`. Verified in-tree: the fleetctl BLOB sha at HEAD is `33cdab8c8d7e…` (`git rev-parse HEAD:fleetctl`), the last commit touching fleetctl is `58895efa…`, and `8fcf1dc1` resolves to NO git object in the repo (`git rev-parse --verify 8fcf1dc1` -> fatal). So `8fcf1dc1…` is a fabricated/uncorroborated sha. It does NOT harm buildability: the LINE NUMBERS are correct against the tree AND the insertion is text-anchored ("match by the quoted line text if numbers drift"), so a builder invents nothing. But a fold map is durable provenance a future re-gate trusts — a bogus sha here is exactly the fold-forward vector that carried r2-B1 into r3-B1. | D6: either drop the parenthetical `(fleetctl sha 8fcf1dc1…)` entirely (the commit `43027d6` + text-anchored line quotes are sufficient and correct provenance), OR replace it with the real fleetctl blob sha `33cdab8c…` (`git rev-parse HEAD:fleetctl`). One-token edit; no design change. |

## Appendix — reasoning (consult on dispute)

### OBSERVED (read/grepped in the tree at HEAD 43027d6; git status --short empty at start and end)
- `cmd_reconcile` tail, grep-confirmed unambiguous: `:1802 for b in "${boxes[@]}"; do`; `:1803
  reconcile_one "$b" "$devs" "$apply" "$RECONCILE_READONLY" || rc=1`; `:1804 done`; `:1805 log
  "reconcile: done ($mode)"`; `:1806 return "$rc"`; `:1807 }`. The fd-9 flock is opened in a brace
  group near :1750 and released implicitly on function return, so a pass inserted between :1804 and
  :1805 IS inside the flock — D6's "fd-9 flock still held there (released only when cmd_reconcile
  returns)" is correct. D6's insertion instruction (between :1804 `done` and :1805 `log`) matches
  EXACTLY, and is additionally guarded by the text anchor.
- fleetctl provenance: `git rev-parse HEAD:fleetctl` = `33cdab8c8d7ee0b06464079f4ecf89b6d404dbce`;
  `git log -1 --format=%H -- fleetctl` = `58895efa59df9c9e67deea9b5738d3caafe4f620`;
  `git rev-parse --verify 8fcf1dc1` -> `fatal: Needed a single revision`. The D6 `8fcf1dc1…` matches
  none of these — sole basis of r4-N1.
- `seed_key_over_tunnel` (fleetctl:1465-1495): `want_sha` computed :1467 via `printf '%s\n' | sha256sum`;
  remote spool -> `got=$(sha256sum)` -> `[ got != want_sha ] -> echo SEED_SHA_MISMATCH >&2; rm; exit 3`
  (:1474) -> else `mv -f` + `chmod 600`; secret on stdin, want_sha on argv. D5's borrowed shape is faithful.
- `_BOX_TOML_AWK` / `config_get` (boxup:214, :254-257): awk `-v want_t -v want_k`, table-scoped,
  comment-aware, first-match-per-file, reads `$CONFIG_FILE`. D1's `config_get_file <file> <table> <key>`
  path-parameterisation + new read-only `boxup config-get` is a minimal faithful refactor; this same
  reader is what closes r2-S1 (on-box `enabled` read delegated to it, not a bare grep).
- `reconcile_rollout` (fleetctl:2054-2110): canary-first, `notify warn` + ABORT on unreachable/failed
  canary (:2082/:2088), rest serially with tunnel-down->skip-continue and verified-failure->break
  (:2102). D6's pass shape mirrors this accurately.
- `.checkfail`/`.seedfail` counters (fleetctl:2259-2278), `reconcile_bump_checkfail` :2259,
  `reconcile_bump_seedfail` :2270, `notify warn` at seedfail>3 :1977. D9's `.cfgfail` clone (bump/reset +
  notify at >3) is faithful.
- `tunnel_up` :1643, `tunnel_ssh` :1651, `reconcile_decide` :1679, `reconcile_one` :1874,
  `reconcile_execute` :1991 — all present at (or adjacent to) their cited lines; blueprint context block
  is accurate.

### JUDGED (design reasoning)
- The gate turns on one question: is r3-B1's D6 seam now correct and buildable? It is. The re-grounded
  numbers are exact against a clean tree, and the added text anchor makes the seam robust to future line
  drift — a strictly stronger fix than a bare renumber, and the right lesson from the r2->r3 fold-forward
  failure. r3-N1 (fold-map mirror) is likewise correct. Both close; the design is zero-decision buildable.
- r4-N1 is deliberately MINOR, not a BLOCKER. It is a false provenance token, not a false instruction:
  the builder places the config pass by the correct line numbers and/or the quoted line text and invents
  nothing, so it fails no zero-decision test. I flag it only because the same fold map that just stopped
  re-seeding a wrong LINE number now carries a wrong SHA number, and a fold map is exactly the durable
  provenance a later re-gate trusts blindly — the identical mechanism that turned r2-B1 into r3-B1. The
  cheapest durable fix is to delete the sha (commit + text anchor already suffice) or use the real blob
  sha. Either is a one-token edit with no design impact; I do not gate on it.
- Invariant safety unchanged and sound: managed.toml as a separate /workspace file preserves "config.toml
  is the user's"; D4's refusal wall keeps [fleet]/tags out of the merge; D3's no-scratch render keeps
  [ssh].password off VPS disk; D5's spool-then-verify keeps a truncated stream from ever installing;
  D6 runs inside the fd-9 flock so a reconcile pass cannot interleave with another. D12's live-canary
  gate (branch boxup to canary only, behaviour-neutral repo value, exercise render/diff/push/reconcile,
  then restore + sha-verify pre-canary state) is well-specified and correctly the EMPIRICAL lane's job —
  I neither ran nor simulated it (no ssh, no tests, per dispatch).
- No uncovered failure mode surfaced this round beyond r4-N1. The empirical gate should still confirm
  (EXECUTION, not mine): the exact D6 insertion compiles and runs once per tick for in-sync boxes; D5's
  exit-3 truncation path leaves managed.toml unchanged on a real box; the D7 `---FILE---` marker parse
  round-trips; and the D12 canary restore is byte-exact.

**Zero-decision buildable: YES.** r3-B1 and r3-N1 closed; all r1/r2 closures intact; precedent-first,
invariant safety, and coherence hold. One MINOR (r4-N1: drop or correct the bogus `fleetctl sha
8fcf1dc1…` provenance token in D6) — a hygiene fix that does not gate.
