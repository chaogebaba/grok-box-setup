**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/empirical-gate-config-truth-r1.md
**Blueprint-Pin-SHA256:** 7f4594027495f85c0bb56386a36f94b9383e32f36f7556f6810d373a811d4f2b (config-truth.md, verify_pin VALID)
**Diff-Pin-SHA256:** 6dc74b43338ac043c506974a4d4815e4374197d6e48a92a7cb8321796bedba3d (config-truth-r1.diff, verify_pin VALID)
**Artifact-Repo-Path:** tmp/orch/empirical-gate-config-truth-r1.md
**Git-SHA-fork:** 95e85fe3ad879b99b2655949d2bb378c32acc179 (feat/config-truth; main=43027d6)

# EMPIRICAL gate + LIVE CANARY (D12) — Phase 2 config-truth (r1)

## VERDICT: **FAIL** — 2 BLOCKER / 1 SHOULD / 2 NIT

Stages 1 (suite) and 2 (mutation) PASS cleanly. The **live canary (Stage 3, run on grok-box-2 per supervisor decision) surfaced two BLOCKER defects** in the pinned diff that the box-free test suite cannot reach because its fake boxup is a POSIX stub. Both are real, reproduced live, and root-caused. The feature MUST NOT merge as-is.

- **BLOCKER-1 (D6): the reconcile config pass skips the ENTIRE fleet on every real tick.** The pass guard is file-*presence* `[ -f "$FLEET_STATE/$b.checkfail" ]`, but `reconcile_reset_checkfail` writes `echo 0 > <box>.checkfail` for every HEALTHY box, and it runs in the per-box loop that executes IMMEDIATELY BEFORE the config pass inside the same `cmd_reconcile`. So every healthy box (canary included) has a `0`-content checkfail file present when the pass runs → every box is skipped → config-truth is inert via its primary driver (D6). Proven live: a manual `reconcile` logged `config: pass start … / pass done` with ZERO per-box lines; grok-box-2's checkfail was recreated (content `0`, mtime 07:10:57) during that very run.
- **BLOCKER-2 (D5/D7/D8): the `[managed] enabled=false` escape hatch reporting is broken end-to-end.** The D5 remote status probe runs `sh "$bx" config-get managed enabled`, but `/bin/sh` on the box is **dash** and boxup uses the bash-only `read -r -d ''` for its TOML awk. Under dash it errors (`read: Illegal option -d`, exit 2) → the `|| echo true` fallback fires → the brain ALWAYS reports `enabled=true`. Live result: with `[managed] enabled=false` set on grok-box-2, `fleetctl config diff grok-box-2` returned **exit 0 (in sync) with NO IGNORED annotation** — exactly the state D7/D8 promise can never occur. (The box's own converge honours the flag — boxup is `#!/bin/bash` — so the box behaves correctly; only the brain's reporting/visibility is wrong. Fix: invoke boxup with `bash`, not `sh`.)
- **SHOULD:** dispatch path drift — `fleetctl` is at **`/opt/grok-fleet/fleetctl`**, not `/usr/local/bin/fleetctl`.
- **NIT:** deployed fleetctl is `8fcf1dc1…` v1.0.0 (matches blueprint base), no config-truth. The reconcile unit gates `--apply` on `config.toml apply=true` (currently `false` ⇒ DRY-RUN).
- **NIT:** the public `boxup config-get <table> <key>` subcommand reads config.toml ONLY (per D1/D5) — so `config-get update repo` correctly returns exit 1 on box-2 (no `[update]` in its config.toml). The D12 wording "config_get returns the managed value" refers to boxup's INTERNAL precedence reader, which was confirmed to return the managed value (see Stage 3 §d).

Everything config-truth does through the OPERATOR surface (D7 render/diff/push for one box) works correctly and atomically against a live box (Stage 3 §d/§e). The two blockers are in the AUTOMATIC path (D6) and the DISABLE-reporting path (D5/D8) — both merge-blocking.

---

## Stage 1 — Suite (feat/config-truth @ 95e85fe) — PASS

| Suite | PASS | FAIL | exit |
|---|---|---|---|
| tests/test-iter3-fixes.sh | 59 | 0 | 0 |
| tests/test-fleet-brain.sh | 192 | 0 | 0 |
| tests/test-boxup-config.sh | 10 | 0 | 0 |
| **make test TOTAL** | **261** | **0** | 0 |

`make lint` → exit 0 (bash -n clean on all 5 scripts). `shellcheck -S warning boxup fleetctl` → exit 0, **0 warnings** (shellcheck 0.11.0).

---

## Stage 2 — Mutation ledger (8/8 KILLED) — PASS

Worktree `/data/cao-scratch/9e4aa018/mut-wt` @ 95e85fe (byte-identical to checkout). Each mutant applied to the worktree, its suite run, then `git restore`; worktree re-verified to baseline hashes after each. Real checkout never touched.

| # | Mutant (file:site) | Change | Killed-by | Result |
|---|---|---|---|---|
| 1 | fleetctl render_managed inputs+awk | both paths unconditional + re-add `2>/dev/null` (P1 regression) | P1 render (a)/(b)/(c), D4 info, D7 render | KILLED |
| 2 | fleetctl managed_remote_script :1849 | drop the stdin sha compare | D5 truncated exit + clobbered-file | KILLED |
| 3 | fleetctl reconcile_config_pass :2051-54 | remove canary-failure abort | D6 canary-abort test | KILLED |
| 4 | fleetctl reconcile_config_pass :2067 | remove non-canary >3 notify | D9 call-site notify>3 | KILLED |
| 5 | boxup config_get :291-99 | config beats managed | 3 boxup precedence tests | KILLED |
| 6 | fleetctl validate_managed :1782 | allow [fleet] table | D4 refuse [fleet] | KILLED |
| 7 | fleetctl push_managed :1908 | break run-scoped unknown-key dedupe | D4 info fired 2x | KILLED |
| 8 | fleetctl cmd_config diff :2890 | report IGNORED file as in-sync | D7 diff enabled=false / support=no | KILLED |

No survivors.

---

## Stage 3 — LIVE CANARY (D12) on grok-box-2 — surfaced BLOCKER-1 and BLOCKER-2

Canary switched to grok-box-2 (grok-box-8 offline; supervisor decision, standing rule "never wait on an asleep box"). Temp-path branch fleetctl `/root/cao-gate-bak-9e4aa018/fleetctl-branch-run` under the unit env; deployed `/opt/grok-fleet/fleetctl` untouched throughout.

### checkfail diagnosis (root cause of BLOCKER-1; requested)
Pre-canary every awake box carried a `.checkfail` FILE: contents 0 for boxes 1,2,3,5,6; box-4=1, box-8=2 (and actively re-bumped each tick — box-4 0→1, box-8 1→2→4 across probes). Journal (`journalctl -u fleet-reconcile.service`) shows every 5-min tick logs `grok-box-N WOULD mint (read-only dry-run/no-apply)` for all boxes and `reconcile: done (DRY-RUN)`. Mechanism (deployed AND branch fleetctl): `reconcile_one` runs `boxup check` over the tunnel; on success it calls `reconcile_reset_checkfail`, whose body is `echo 0 > "$FLEET_STATE/$1.checkfail"` (fleetctl:2694 branch / :2267 deployed) — i.e. a HEALTHY box KEEPS a `0`-content checkfail FILE. This is NOT a main bug per se (it is the established checkfail convention: 0=healthy, >0=consecutive failures, threshold >3 at fleetctl:1725). It becomes a bug ONLY in the branch's new D6 guard, which tests file PRESENCE instead of content/threshold. Verdict: BLOCKER-1 is a branch (D6) defect, not a pre-existing main defect.

### D12 step results (all commands + exit codes)
- **(a) backups+shas** — captured (dual: VPS staging + laptop /data), timer stopped (was active→inactive, still enabled), `canary_box="grok-box-2"` added under [fleet-brain], box-2 `.checkfail` moved aside.
- **(b) install** — temp branch fleetctl `5c286f4d…` (config-truth present: 7 grep hits); deployed fleetctl `8fcf1dc1…` untouched. Branch boxup pushed to box-2 (sha `ab90d6f1…`, mode 755 root:root, tail-sentinel verified, now `MANAGED_FILE=` present). RC 0.
- **(c) fleet.toml** — `/etc/grok-fleet/fleet.toml` `[update] repo = "https://github.com/chaogebaba/grok-box-setup.git"` (behaviour-neutral = box baked default `DEFAULT_REPO_URL`), mode 600, sha `557b6058…`; no boxes/ dir.
- **(d) operator surface — ALL CORRECT:**
  - `config render grok-box-2` → shows `[update] repo = …` (not header-only), RC 0.
  - `config diff grok-box-2` (pre-push) → correct unified diff, **exit 1** (drift).
  - `config push grok-box-2` → RC 0; box managed.toml written, **mode 600 root:root**, sha `dd15bf79…`.
  - `config diff grok-box-2` (post-push) → **exit 0** (in sync).
  - box internal `config_get update repo` → returns the **managed value** `https://github.com/chaogebaba/grok-box-setup.git` (rc 0), sourced from managed.toml (config.toml has no [update]). ✓ D1 precedence live.
- **(e) reconcile DRY-RUN** — `reconcile: done (DRY-RUN)`, RC 0, BUT `config: pass start (dry-run) … canary=grok-box-2 / pass done` with **ZERO per-box lines** ⇒ **BLOCKER-1** (see diagnosis). Spot-check: grok-box-1 has **no managed.toml** (dry-run wrote nothing); box-2 managed.toml unchanged; no `.cfgfail` created. Separately, the D5/D7 `support=no` inert path was confirmed live via `config diff grok-box-1` (old boxup): prints `NOTE: boxup on grok-box-1 lacks managed support — pushed values are IGNORED (deploy boxup first)`, exit 1, no managed.toml written to box-1. ✓
- **(f) [managed] enabled=false on box-2** — `config diff grok-box-2` returned **exit 0, NO IGNORED annotation** ⇒ **BLOCKER-2**. Root cause proven: on box, `sh boxup config-get managed enabled` → `read: Illegal option -d` exit 2 (dash); `bash boxup config-get managed enabled` → `false`. `/bin/sh` → dash. box-2 config.toml restored byte-identical after each probe.
- **(g) EXACT restoration** — see sha table; `systemctl start fleet-reconcile.service` → **Result=success, ExecMainStatus=0**, clean DRY-RUN journal, no config-truth artefacts, timer active. VPS backup dir removed.

### Restoration sha table (pre == post, independently re-read after restore)
| File | Pre sha256 | Post sha256 | Match |
|---|---|---|---|
| VPS /opt/grok-fleet/config.toml | b06c88fd…69a096 | b06c88fd…69a096 | ✓ (canary_box removed) |
| VPS /opt/grok-fleet/fleetctl | 8fcf1dc1…e70069 | 8fcf1dc1…e70069 | ✓ (untouched) |
| VPS grok-box-2.checkfail | 9a271f2a…ab86aa (content 0) | 9a271f2a…ab86aa (content 0) | ✓ |
| box-2 /workspace/box-setup/boxup | 05f8c62c…219450 (mode 755) | 05f8c62c…219450 (mode 755) | ✓ |
| box-2 /workspace/box-setup/config.toml | b9c3a144…cfb8e (mode 600) | b9c3a144…cfb8e (mode 600) | ✓ |
| box-2 /workspace/box-setup/managed.toml | absent | absent | ✓ (removed) |
| /etc/grok-fleet/fleet.toml | absent | absent | ✓ (removed) |

Fleet is byte-identical to pre-canary state. `fleet-reconcile.timer` active+enabled; one post-restore service run = Result=success.

---

## Empirical checks (RAN vs inferred)
RAN: 3 suites (exact counts); shellcheck; 8 mutants (apply→run→revert→hash-verify); full VPS/box recon; the entire D12 a–g live sequence with exact restore; both blockers reproduced and root-caused (checkfail recreation timing; dash-vs-bash `read -d`); post-restore Result=success + fresh sha table.
INFERRED: none material — the two blockers are observed facts, not inference.

## Findings summary (ranked)
- **BLOCKER-1 (D6):** config pass guard `[ -f .checkfail ]` skips every healthy box (reset writes a `0` file each tick). Fix: gate on checkfail CONTENT/threshold (e.g. `>3` like fleetctl:1725), not file presence. Recommended test: extend test-fleet-brain.sh D6 cases to seed a `0`-content `<box>.checkfail` and assert the box is STILL processed (a fake-boxup reconcile-then-pass fixture reproduces it; the current fixtures create the file only to simulate failure, never the healthy-0 case).
- **BLOCKER-2 (D5/D8):** remote status probe runs boxup under `sh` (dash) → `enabled` always `true` → enabled=false escape hatch reports in-sync with no IGNORED annotation. Fix: `bash "$bx" config-get …` in `managed_remote_script`. Recommended test: a dash-shell status-probe case, or assert the remote invokes bash.
- **SHOULD:** fleetctl path is /opt/grok-fleet/fleetctl (doc/dispatch drift).
- **NIT:** apply=false (DRY-RUN) is the live default.
- **NIT:** public `boxup config-get` is config.toml-only by design (D1) — not a bug.

## Scratch / evidence (all under /data/cao-scratch/9e4aa018/)
- Worktree: mut-wt (clean). Logs: s1-*.log, m1..m8.log.
- Canary scripts: diag-checkfail{,2}.sh, d12a-*.sh, d12b-install.sh, d12c-fleettoml.sh, d12d-*.sh, d12e-*.sh, d12f-*.sh, d12g-*.sh.
- Laptop backups (authoritative, retained): prestate/{box2-boxup.bak, box2-config.toml.bak, vps-config.toml.bak, vps-grok-box-2.checkfail.bak}.
