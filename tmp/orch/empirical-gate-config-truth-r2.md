**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/empirical-gate-config-truth-r2.md
**Artifact-SHA256(diff-pin):** 1615337b9e05dc4ba16e7adde86d0613daf41b91b0c71540f6e080ce5b9241d8 (config-truth-r2.diff, verify_pin VALID at start AND end)
**Blueprint-Pin-SHA256:** 7f4594027495f85c0bb56386a36f94b9383e32f36f7556f6810d373a811d4f2b (config-truth.md r4, verify_pin VALID)
**Artifact-Repo-Path:** tmp/orch/empirical-gate-config-truth-r2.md
**Git-SHA-fork:** 3dd8c66d0b553d9790b5b52cf303587abe92dcc5 (feat/config-truth; main=43027d69)

# EMPIRICAL gate r2 + LIVE CANARY (D12) — config-truth (re-gate after r1 blockers fixed)

## VERDICT: **PASS** — 0 BLOCKER / 2 SHOULD / 2 NIT

Both r1 BLOCKERs are fixed and PROVEN FIXED LIVE on the real fleet (canary grok-box-2),
not merely in the box-free suite. Stage 1 (suite) and Stage 2 (mutation) pass cleanly.
Stage 3 (live canary) reproduces the exact r1 failure scenarios and shows correct behaviour
this time. The feature is buildable/mergeable. The two SHOULDs are regression-net (test)
gaps surfaced by escaped mutants — the shipped runtime is correct in both; no code defect.

- **B1 FIXED (D6, live):** the reconcile config pass now emits **per-box lines for the whole
  reachable fleet** while box-2's `.checkfail` is PRESENT containing `0` (kept in place, not
  moved aside). In r1 the same pass produced ZERO per-box lines (whole fleet skipped). The
  count-gate (`reconcile_checkfail_count > 3`) replaces the presence guard; a `0`-content
  healthy file no longer skips a box.
- **B2 FIXED (D5/D7/D8, live):** with `[managed] enabled=false` on box-2, `config diff` now
  prints the IGNORED annotation and returns **exit 1** (never in-sync for an ignored file),
  and the push status line reads `enabled=false`. In r1 this returned exit 0 with NO
  annotation. Root cause reconfirmed live: boxup under `sh` (dash) errors
  (`read: Illegal option -d`, exit 2); under `bash` it works. The probe now invokes `bash`.
- **SHOULD-1 (test gap, not a defect):** no boundary test at checkfail count == 3. Escaped
  mutant M2 (`-gt 3` → `-ge 3`) survives the suite. Runtime threshold is correct (`>3`,
  matching `reconcile_decide`); a future refactor could regress the boundary undetected.
- **SHOULD-2 (test gap, not a defect):** no `config diff` test that drives `enabled=unknown`
  and asserts exit 1. Escaped mutant M5 (drop the `enabled != unknown` clause from the diff
  in-sync guard) survives. The shipped guard IS correct (fleetctl:2932 requires enabled
  not-false AND not-unknown for exit 0 — read and verified), and the push_managed annotation
  path IS tested; only the diff exit-code path for `unknown` lacks a test.
- **NIT-1 (design nuance, live):** when a box's config.toml has NO `[managed]` table, the
  box's `config-get managed enabled` exits 1 (config-get is config.toml-only by D1), so the
  brain reports `enabled=unknown` and `config diff` returns exit 1 even when the sha matches.
  This is the fix's INTENDED conservative behaviour ("never a false enabled=true"), confirmed
  correct: with an explicit `[managed] enabled=true` the probe returns `true` and diff returns
  exit 0. Operators who want a clean in-sync signal must set `enabled=true` explicitly. Worth
  a one-line doc note; not a defect.
- **NIT-2:** dispatch/doc path drift persists — deployed `fleetctl` is at
  `/opt/grok-fleet/fleetctl` (no `/usr/local/bin/fleetctl`), and `apply=false` (DRY-RUN) is the
  live default. Deployed fleetctl is `8fcf1dc1…` (pre-config-truth) — this feature is not yet
  deployed; the canary ran the branch fleetctl from a temp path only.

Zero-decision buildable: **YES** — a builder can fold the two SHOULD test-recommendations and
merge with no invented decisions. The SHOULDs add coverage; they do not change code.

---

## Stage 1 — Suite (feat/config-truth @ 3dd8c66) — PASS

| Suite | PASS | FAIL | exit |
|---|---|---|---|
| tests/test-iter3-fixes.sh | 59 | 0 | 0 |
| tests/test-fleet-brain.sh | 200 | 0 | 0 |
| tests/test-boxup-config.sh | 10 | 0 | 0 |
| **make test TOTAL** | **269** | **0** | 0 |

`make lint` → exit 0 (bash -n clean on all 5 scripts). `shellcheck -S warning boxup fleetctl`
→ exit 0, **0 warnings** (shellcheck 0.11.0). Working tree byte-identical after
(fleetctl f8b63ced…, boxup ab90d6f1…). Pinned diff verified IDENTICAL to `git diff main..3dd8c66`
(sha 1615337b…).

---

## Stage 2 — Mutation ledger (5 KILLED / 2 SURVIVED) — PASS

Worktree `/data/cao-scratch/53bba020/mut-wt` @ 3dd8c66 (byte-identical). Each mutant applied,
its relevant suite run, then `git restore`; worktree re-verified to baseline hashes after each.
Real checkout never touched.

| # | Mutant (target) | Change | Result | Killed-by |
|---|---|---|---|---|
| M1 | B1 non-canary guard | restore file-PRESENCE guard `[ -f …checkfail ]` (the r1 bug) | **KILLED** | `BLOCKER-1: healthy 0-content box was SKIPPED` |
| M2 | B1 threshold | off-by-one `-gt 3` → `-ge 3` (count==3 wrongly skipped) | SURVIVED | *(no count==3 test — SHOULD-1)* |
| M3 | B2 probe shell | restore `sh "$bx"` (dash) instead of `bash` (the r1 bug) | **KILLED** | `failed probe not reported as unknown` + static `invokes boxup via bash` |
| M4 | B2 probe fallback | failed probe `\|\| enabled=true` (the r1 bug) | **KILLED** | `failed probe not reported as unknown` |
| M5 | B2 diff guard | drop `enabled != unknown` from the diff in-sync guard | SURVIVED | *(no diff enabled=unknown exit-1 test — SHOULD-2; runtime guard verified correct)* |
| M6 | r1 #8 (re-confirm) | `config diff` reports enabled=false as in-sync | **KILLED** | `D7 diff enabled=false must not be in-sync` |
| M7 | r1 #5 (re-confirm) | boxup config beats managed (precedence inversion) | **KILLED** | `managed did not shadow config` |

Both r1-re-confirm mutants (M6 = r1 #8, M7 = r1 #5) KILLED. The two survivors (M2, M5) are the
two SHOULD test-gaps; I read the shipped code for each and confirmed the runtime behaviour is
correct (M2: threshold is `>3` at both guards; M5: fleetctl:2932 keeps the not-unknown clause).

---

## Stage 3 — LIVE CANARY (D12) on grok-box-2 — both r1 blockers shown FIXED LIVE

Brain = tailnet node `fleet-brain` (100.68.31.7), reached as root. Boxes reached over their
reverse tunnels (`ssh -i /etc/grok-fleet/box_access_ed25519 -p 2000N box@127.0.0.1`; box-2 = 20002).
Deployed `/opt/grok-fleet/fleetctl` (`8fcf1dc1…`, pre-config-truth) UNTOUCHED throughout; the
branch fleetctl (`f8b63ced…`) + boxup (`ab90d6f1…`) ran from a `/root/cao-gate-bak-53bba020`
scratch dir under the reconcile unit env (HOME=/var/lib/grok-fleet FLEET_CONFIG=/opt/grok-fleet/config.toml
FLEET_ETC=/etc/grok-fleet FLEET_STATE=/var/lib/grok-fleet). Timer stopped for the run, restarted after.
box-7/box-8 not touched (box-8 appeared only as a read-only dry-run probe line). VPS /root personal
services (xray/hysteria/wg0/sshd) never touched.

### (i) B1 fixed live — manual DRY-RUN reconcile config pass (branch fleetctl)
box-2 `.checkfail` PRESENT, content `0`, NOT moved aside. Observed config-pass log:
```
config: pass start (dry-run) — canary-first over tunnels (canary=grok-box-2)
config: grok-box-2 WOULD push (none->dd15bf79…) [enabled UNKNOWN: box managed-status probe failed …]
config: grok-box-1 WOULD push (none->dd15bf79…) [inert: boxup lacks managed support — deploy boxup first]
config: grok-box-3 … [inert …]   config: grok-box-4 … [inert …]   config: grok-box-5 … [inert …]
config: skip grok-box-6 — tunnel down (drift reported when the box returns)
config: grok-box-8 WOULD push (none->dd15bf79…) [inert …]
config: pass done (dry-run)
```
PER-BOX lines for the whole reachable fleet, canary first. In r1 this pass produced ZERO
per-box lines. box-2 `.checkfail` still present/`0` after the run; no managed.toml written in
dry-run. **B1 fixed.** (The `enabled UNKNOWN` on box-2 is NIT-1, explained below — not a regression.)

### (ii) B2 fixed live — [managed] enabled escape hatch on box-2
- **enabled=true:** `config push` → `config: grok-box-2 in sync`; `config diff` → **exit 0 (in sync)**.
- **enabled=false:** `config push` → `config: grok-box-2 in sync [IGNORED locally: [managed] enabled=false]`;
  `config diff` → `NOTE: [managed] enabled=false on grok-box-2 — pushed values are IGNORED on this box`,
  **exit 1**.
In r1 the enabled=false case returned exit 0 with no annotation. Root cause reconfirmed live:
`sh ./boxup config-get managed enabled` → `read: Illegal option -d`, exit 2 (`/bin/sh`→dash);
`bash ./boxup config-get managed enabled` → real value, exit 0 (bash 5.2.37). **B2 fixed.**
box-2 config.toml restored byte-identical (b9c3a144…) after each probe.

### D12 operator surface (all correct)
- `config render grok-box-2` → full `[update] repo = …` body (not header-only), rc 0.
- `config diff` (pre-push) → correct unified diff, exit 1 (drift).
- `config push grok-box-2` → rc 0; box `managed.toml` written **mode 600 root:root**, sha `dd15bf79…`.
- `config diff` (post-push, enabled=true) → **exit 0 (in sync)**.
- D1 precedence live: config.toml has no `[update]`, managed.toml has it; both
  `config_get_file managed.toml update repo` and the `config_get update repo` precedence wrapper
  return the managed value `https://github.com/chaogebaba/grok-box-setup.git` (rc 0). (An earlier
  empty read was a flaw in my probe shim — it did not source `_BOX_TOML_AWK`; the deployed boxup
  parses correctly.)

### EXACT restoration (independent post-read; pre == post)
| File | Pre sha256 | Post sha256 | Match |
|---|---|---|---|
| VPS /opt/grok-fleet/config.toml | b06c88fd… | b06c88fd… | ✓ (canary_box removed) |
| VPS /opt/grok-fleet/fleetctl | 8fcf1dc1… | 8fcf1dc1… | ✓ (untouched) |
| VPS grok-box-2.checkfail | 9a271f2a… (content 0) | 9a271f2a… (content 0) | ✓ (kept in place) |
| VPS /etc/grok-fleet/fleet.toml | absent | absent | ✓ (removed) |
| box-2 /workspace/box-setup/boxup | 05f8c62c… (mode 755) | 05f8c62c… (mode 755) | ✓ |
| box-2 /workspace/box-setup/config.toml | b9c3a144… (mode 600) | b9c3a144… (mode 600) | ✓ |
| box-2 /workspace/box-setup/managed.toml | absent | absent | ✓ (removed) |

Timer active+enabled. One post-restore `fleet-reconcile.service` run → **Result=success,
ExecMainStatus=0**, clean DRY-RUN journal (grok-box-1/2/3/4/5/8 WOULD mint, `done (DRY-RUN)`),
no config-truth artefacts (deployed fleetctl is pre-config-truth). No stray scratch on box-2.
VPS scratch dir removed. Fleet byte-identical to pre-canary state.

---

## Empirical checks (RAN vs inferred)
RAN: 3 suites (exact counts 59/200/10 = 269, 0 fail); make lint; shellcheck 0.11.0; 7 mutants
(apply→run→revert→hash-verify each); pin verify at start AND end (both VALID); full live D12
sequence on grok-box-2 with both blockers reproduced-then-shown-fixed; dash-vs-bash probe
reproduced live; D1 precedence read live; exact restore + independent post-read sha table;
post-restore Result=success. Read fleetctl:2932 to confirm M5's guard is correct in the shipped code.
INFERRED: none material — the PASS rests on observed live facts, not reasoning.

## Test recommendations for the builder (fold; do not block)
- **SHOULD-1:** add a `cfgpass_checkfail_test 3` boundary case asserting a count==3 box IS
  processed (threshold is strictly `>3`), killing the `-ge 3` off-by-one (M2).
- **SHOULD-2:** add a `config diff` case that drives `enabled=unknown` (fake boxup whose
  managed-status probe fails) and asserts the diff prints the "could not read [managed] enabled"
  NOTE and returns exit 1, killing the dropped-not-unknown-guard mutant (M5). An attachment
  reproducing M5 lived transiently in the scratch worktree; fold the assertion into
  test-fleet-brain.sh alongside the existing D7 diff cases.

## Scratch / evidence (all under /data/cao-scratch/53bba020/)
- mutate2.sh (final battery) + m1..m7.log; mut-wt (removed after run); baseline-hashes.txt.
- Canary scripts: d12a-setup.sh, d12i-reconcile.sh, d12-probe-b2*.sh, d12d-opsurface.sh,
  precedence-shim2.sh/run-precedence.sh, d12ii-enabled.sh, d12g-restore.sh, d12g-final-verify.sh.
- VPS scratch (/root/cao-gate-bak-53bba020) created, used, and REMOVED at end.
