**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/empirical-gate-fleetctl-bug-f2.md
**Artifact-SHA256:** ff4f945de3eff18583dfcd13f05b3921f1fa9946bea65c1fa586ae7810973249
**Artifact-Repo-Path:** tmp/orch/empirical-gate-fleetctl-bug-f2.md
**Git-SHA-root:** f265625ef8083521c79aff4ba78ecd3888f4a729
**Git-SHA-base:** 0c34fba5aa057e4fb3d85464f205ced3996a5f18

# EMPIRICAL GATE + LIVE CANARY — fleetctl BUG-F fix

- Subject: `fix/fleetctl-bug-f` @ f265625 (worktree .cao/worktrees/20bf4863, branch cao/20bf4863; base main 0c34fba)
- Frozen artifact (verify_pin): `tmp/orch/bug-f.diff` sha256 `ff4f945de3eff18583dfcd13f05b3921f1fa9946bea65c1fa586ae7810973249` — VALID at start AND end.
- Pin equivalence: `git diff 0c34fba..HEAD` is **byte-identical** to the pinned artifact (same sha256 ff4f945d).
- VPS canary: root@107.172.132.211, scope only /opt/grok-fleet, /etc/grok-fleet, /var/lib/grok-fleet, fleet-reconcile.service.

## VERDICT: PASS — 0 BLOCKER / 0 SHOULD / 0 NIT

The BUG-F fix is correct and empirically proven both box-free and live. The
`set -u` "since: unbound variable" crash was **reproduced on the real VPS**
against the deployed OLD binary (sha a01df1d6) driving the exact
`reconcile_alert_asleep` code under the real unit env with no pre-existing
`.asleep` file, and the branch binary on the SAME input does not crash: it
writes `<epoch> 0` on the first both-dead observation, and a full
`systemctl start fleet-reconcile.service` finished `Result=success
ExecMainStatus=0` with DRY-RUN rows. Mutation coverage is complete: all 3
mutants (M1/M2/M3) are killed by named tests. Diff audit confirms alert
timing semantics and the enrolled.tsv row format are unchanged.

### Findings (one line each)
- (none) No BLOCKER/SHOULD/NIT. Fix, tests, diff, and live behavior all consistent.

## STAGE 1 — box-free (all mutation work on a scratch copy; working tree byte-identical after)

- `make lint` → `bash -n` clean on boxup, fleetctl, install.sh, box-bootstrap.sh, vps/install-vps.sh; shellcheck not installed (skipped). **exit 0**.
- `bash tests/test-iter3-fixes.sh` → **ALL TESTS PASSED** (exit 0).
- `bash tests/test-fleet-brain.sh` → **106 PASS / 0 FAIL**, "ALL FLEET-BRAIN TESTS PASSED" (matches expected 106). The 5 new BUG-F tests all pass.

### Mutation ledger (apply → run `tests/test-fleet-brain.sh` → RESTORE from snapshot; baseline 106/0 reconfirmed after each restore)

| Mutant | Change | Result | Killing test(s) | Counts |
|--------|--------|--------|-----------------|--------|
| **M1** | Revert `since=""`/`last=""` init back to bare `local ... now since last` | **KILLED** | `BUG-F: reconcile_alert_asleep fresh run wrong: []` — empty output = `set -u` abort before any echo (the exact live crash) | 105 P / 1 F |
| **M2** | Drop the dedup pre-pass (`if [ -f "$enr" ]; grep -v -E "^$box"$'\t' ...`) in `enroll_record_enrolled` | **KILLED** | `BUG-F: enroll append not idempotent for grok-box-8: [rows8=2]` **and** `BUG-F: enroll dedup ... row count wrong` | 104 P / 2 F |
| **M3** | Make `reconcile_alert_asleep` write to `/dev/null` instead of `"$f"` (skip persisting state) | **KILLED** | `BUG-F: reconcile_alert_asleep crashed / wrote no since` (rc=0 but NO-STATE) | 105 P / 1 F |

All 3 mutants killed (3/3). After each mutant the file was restored from the pre-mutation snapshot (sha `8a80e68e...`) and the 106/0 baseline reconfirmed; final `git status` clean, worktree fleetctl sha `8a80e68e...`.

### Diff audit

- **Alert timing semantics UNCHANGED.** Inside `reconcile_alert_asleep` the only code change is the declaration line (`local f=... now since last` → `... now since="" last=""`). The timing constants are byte-identical to base: `FLEET_ASLEEP_T_SECS=7200` (2h before first alert) and `FLEET_ASLEEP_DIGEST_SECS=86400` (daily digest). The `case`-normalization (`since→now`, `last→0`), the `elapsed` computation, the "no alert yet → fire at `elapsed >= T`" branch, and the "already alerted → daily digest" branch are unchanged. The init supplies exactly the values the downstream `case` statements already implied; the previous code merely aborted under `set -u` before reaching them. First-alert-at-T-both-dead then daily-digest cadence is preserved.
- **enrolled.tsv row format UNCHANGED.** Both old and new append via `printf '%s\t%s\n' "$box" "$port"` → identical `box<TAB>port` row. The new `enroll_record_enrolled` only adds a tab-anchored dedup pre-pass (`grep -v -E "^$box"$'\t'`) that drops a pre-existing row for the same box before appending. The `$'\t'` anchor pins the whole name so `grok-box-1` does not match `grok-box-10` — confirmed by M2 kill and the per-box test (`rows1=1`, `total=2`).

## STAGE 2 — LIVE CANARY (VPS 107.172.132.211; scope: /opt/grok-fleet, /etc/grok-fleet, /var/lib/grok-fleet, fleet-reconcile.service)

Real unit env (from `systemctl cat fleet-reconcile.service`):
`HOME=/var/lib/grok-fleet`, `FLEET_CONFIG=/opt/grok-fleet/config.toml`,
`FLEET_ETC=/etc/grok-fleet`, `FLEET_STATE=/var/lib/grok-fleet`; config
`apply = false` → DRY-RUN. All harnesses used a **scratch** FLEET_STATE
(`/tmp/bugf-canary.XXXXXX/state*`); real `/var/lib/grok-fleet` never used as
harness state.

### Reproduce (OLD deployed binary, sha a01df1d6…, under `bash -u`, scratch state, no prior .asleep, T=0)
```
=== OLD binary sha ===
a01df1d6b701d7af446c025bf9ad9c217bbd8e7e2e7fed07ddeb7338d08ce18a  /opt/grok-fleet/fleetctl
--- invoking reconcile_alert_asleep grok-box-1 (no prior .asleep, bash -u) ---
harness_exit=1
/tmp/bugf-canary.xSsab6/canary-old.sh: line 23: since: unbound variable
```
→ CRASH reproduced: `since: unbound variable`, harness exits 1, RESULT/STATEFILE never reached (aborts at `case "$since"`). This is the live failure ("line 1995: since: unbound variable", 4× fleet-reconcile failures 01:43-01:59Z).

### Install branch binary (backup old → install, 755 root:root)
```
=== backup old binary ===
a01df1d6...  /tmp/bugf-canary.xSsab6/fleetctl.backup
=== install branch (owner root:root mode 755) ===
-rwxr-xr-x 1 root root 95492 ... /opt/grok-fleet/fleetctl
8a80e68eb77f300a717b86bc60f3cdbe9931d1a491aa785ac450fb875dd589ca  /opt/grok-fleet/fleetctl
```

### Prove (NEW branch binary, sha 8a80e68e…, SAME `bash -u` harness)
```
=== Case A: default T=7200, no prior .asleep (expect rc=0, writes '<epoch> 0') ===
RESULT rc=0
STATEFILE: [1787972452 0]
since=OK(epoch=1787972452)
last=0

=== Case B: T=0, no prior .asleep (expect rc=0, alert fires, '<epoch> <epoch>') ===
RESULT rc=0
STATEFILE: [1787972452 1787972452]
harness_exit=0
```
→ No crash. Case A writes `<epoch> 0` to `<box>.asleep` (first observation, no premature alert); Case B fires the alert and stamps `<epoch> <epoch>`.

### Full service run (NEW binary)
```
systemctl start fleet-reconcile.service
Result=success   ExecMainStatus=0   ActiveState=inactive   SubState=dead
[2026-08-29T03:00:14Z] reconcile: start (DRY-RUN)
[...] grok-box-1..6,8 WOULD mint (read-only dry-run/no-apply)
[2026-08-29T03:00:22Z] reconcile: done (DRY-RUN)
fleet-reconcile.service: Deactivated successfully.
```
→ Result=success, ExecMainStatus=0, DRY-RUN rows for all 7 boxes.

### Restore + cleanup
```
=== restore original binary from backup ===
-rwxr-xr-x 1 root root 94695 ... /opt/grok-fleet/fleetctl
a01df1d6b701d7af446c025bf9ad9c217bbd8e7e2e7fed07ddeb7338d08ce18a  /opt/grok-fleet/fleetctl   (== expected)
=== delete scratch dir ===  (gone)
```
- Final `sha256(/opt/grok-fleet/fleetctl)` = **a01df1d6b701d7af446c025bf9ad9c217bbd8e7e2e7fed07ddeb7338d08ce18a** ✓ (matches required restore target; 755 root:root).
- Scratch dir `/tmp/bugf-canary.xSsab6` deleted.
- Real `/var/lib/grok-fleet`: `enrolled.tsv` untouched (136 B, Aug 29 00:47); **no `.asleep` file leaked** (harness used scratch dirs only). `*.checkfail` / `api.fails` timestamps advanced to 03:01 as a side effect of the DRY-RUN reconcile runs I triggered — normal read-only counter behavior (2-byte values unchanged), not written by my harness; next 5-min tick would do the same.

## Out-of-scope confirmation
No files under /root and no other services (xray/hysteria/wg0/sshd config) were read, audited, or modified. Only /opt/grok-fleet/fleetctl (backed up + restored), the fleet-reconcile unit (queried + started once DRY-RUN), and a /tmp scratch dir (created + deleted) were touched.

## Summary
- Verdict: **PASS** — 0 BLOCKER / 0 SHOULD / 0 NIT
- Stage 1: lint clean; iter3 all pass; fleet-brain 106/0. Mutants 3/3 KILLED (M1, M2, M3).
- Stage 2: OLD-binary crash reproduced; NEW-binary no-crash + `<epoch> 0` write + service Result=success/ExecMainStatus=0 proven; original binary restored (sha a01df1d6 ✓); scratch cleaned; real state as-found.
