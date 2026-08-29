**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/box-naming-3digit-r1.diff
**Artifact-SHA256:** 4085d169cfb4cc9409e9263d12ce4df748a0f4719c9263652a56d26840cc4c69
**Artifact-Repo-Path:** tmp/orch/box-naming-3digit-r1.diff
**Git-SHA-root:** cd5130183817f3ba4531cab5529734453d40fa67

# EMPIRICAL GATE — box-naming-3digit r1

## VERDICT: PASS with conditions — 0 BLOCKER / 3 SHOULD / 1 NIT

Code is correct and empirically sound: all 5 claims verified, suite 387 PASS/0 FAIL,
7/9 mutants caught. The live migration renamed 5 of 6 targeted awake boxes cleanly
(1,2,4,5,6 → 001,002,004,005,006), F6 (`~fleet/.ssh/authorized_keys`) UNCHANGED across
every rename, the reconcile timer was never stopped and every tick was `failed=0`.

**One live box (grok-box-8) could NOT complete its rename** — a tailscale MagicDNS
label pin the brain's `POST /device/<id>/name` did not override. This is an
environmental/operational condition on that one node (its label was pre-pinned;
blueprint Facts flagged exactly this for box-8), NOT a defect in the diff — the rename
behaved to spec: aborted safely, left both names valid/resumable, tunnel never dropped,
authkeys untouched. It needs an operator decision (below), so the gate is PASS-with-
conditions rather than an unqualified PASS. Two of the nine mutants (delete-before-verify,
flock bounded-wait) are MISSED because of test-harness stubs, not code — coverage SHOULDs.

| id | sev | claim | smallest amendment |
|----|-----|-------|--------------------|
| S1 | SHOULD | Mutant f (`flock -w 90` → `flock -n`) is NOT caught: the rename test's `flock` stub ignores its args, so the F2/F7 bounded-wait contract is unproven | Make the flock stub argument-aware and assert the rename passes `-w 90` (repro + patch in attachment `flock-wait-gap.sh`) |
| S2 | SHOULD | Mutant d (delete-old-state moved BEFORE verify) is NOT caught: `tunnel_up` is stubbed `return 0`, so the post-rename verify can never fail and "delete-last / resumable-on-failed-verify" is unobservable | Add a `HOOK_VERIFY_FAIL` path and assert old-name state SURVIVES a failed verify (repro + patch in attachment `delete-last-gap.sh`) |
| S3 | SHOULD | Live: `fleetctl rename grok-box-8 grok-box-008` cannot complete — MagicDNS label stays `grok-box-8` after the brain POST; box `boxup check=FAIL reason=name`. State left with BOTH grok-box-8 and grok-box-008 enrolled (resumable) | Operator decision needed (see "Box-8 open item"). Not a diff defect; consider a rename option to force the tailnet DNS label or reap+re-register the split node, and/or surface the POST's response body in the timeout log |
| N1 | NIT | `FLEETCTL_VERSION` stays `1.0.0` while `VERSION`/`BOXUP_VERSION` bump to 5.3.0 (brief asked VERSION↔BOXUP_VERSION to agree — they do; fleetctl versions independently and `RENAME_MIN_BOXUP_VERSION=5.3.0` gates the box correctly) | None required; note the independent scheme in D8/docs if desired |

**Zero-decision buildable:** N/A — this is a diff/live gate, not a blueprint gate. The
diff needs no builder decisions; the only open item is an OPERATIONAL one on grok-box-8.

**Recommendation:** PASS the code. Before declaring the fleet fully migrated, resolve the
grok-box-8 DNS-label pin and rename the currently-asleep boxes (3, 7, 11) when they wake.
The branch itself requires no code change to merge; S1/S2 are test-coverage follow-ups.

---

# APPENDIX — evidence

Review worktree: `/data/cao-scratch/8a0d26ff/wt-box-naming` (branch `feat/box-naming-3digit`,
HEAD cd51301, base main 7e90606). Byte-identical to baseline at start AND end (never-edit
wall held; all 6 in-scope file hashes unchanged; `git status` clean). Frozen pins re-verified
VALID at task start and before this callback. Full ledger of state-changing commands:
`/data/cao-scratch/8a0d26ff/box-actions-s3.log` (fx121 hook blocks the canonical
`/data/orchestrator/grok-box-setup/box-actions` path — kept in scratch per the dispatch).

## Diff faithfulness
`git diff main..feat/box-naming-3digit` on the checked-out branch reproduced sha256
`4085d169…` (2177 lines) — byte-identical to the frozen artifact.

## Claims (all VERIFIED)
1. **D1/F1 helpers + octal.** `box_name_from_index`/`box_index_from_name` function bodies
   are byte-identical between boxup and fleetctl (`diff` of extracted bodies: IDENTICAL).
   Behavioral harness: `box_index_from_name` 008→8, 009→9, 011→11, grok-box-1→1, bare 8/9/11→
   same, grok-box-1000→rc1, grok-box-x→rc1, grok-box-→rc1; `box_name_from_index` 8→grok-box-008,
   11→grok-box-011, 2→grok-box-002; `port_for` grok-box-008..011 → 20008..20011. Octal bug
   CONFIRMED on main: `$((20000+008))` errors, `$((20000+011))`=20009; `10#` fix gives 20011.
   Only two `20000 + n` sites (boxup fleet_port, fleetctl port_for), both fed by the helper;
   no other suffix arithmetic.
2. **D2 pick_name** emits `grok-box-{n:03d}`, counts both padded and legacy peers as taken.
3. **D3 key_meta_file** → `box_index` → `box_index_from_name` ⇒ grok-box-008 maps to keys/8.json.
4. **D4/F3/F6/F7 rename** implements copy-first → box hostname write + `boxup once` → poll/verify
   (HostName+DNS label) → delete-last, under the reconcile lock via `flock -w 90` on
   `$FLEET_STATE/reconcile.lock` (timer NOT stopped), `--dry-run` prints the 7-artefact plan,
   copies/deletes only AUDIT copies (`.line`, `.map` row, `.expires`/`.checkfail`/`.cfgfail`,
   `boxes/*.toml`, enrolled rows) and never touches `~fleet/.ssh/authorized_keys`. DNS-pin path
   POSTs `/device/<id>/name`; corpse reaping deletes only the non-live id.
5. **D5** numeric ordering via `sort -n -k1,1` in reconcile_target_boxes (VERIFIED live below);
   canary normalisation `box_name_from_index "$c"` (8/grok-box-8/grok-box-008 → grok-box-008).
   **Version:** VERSION 5.2.0→5.3.0, BOXUP_VERSION=5.3.0 (agree). FLEETCTL_VERSION 1.0.0 (indep).

## Empirical checks (RAN — observed results)
- **S1 suite:** `make test` = **387 PASS / 0 FAIL** across test-iter3-fixes.sh, test-fleet-brain.sh,
  test-boxup-config.sh. `make lint` (`bash -n` ×5) clean. `shellcheck -S warning boxup fleetctl
  install.sh box-bootstrap.sh vps/install-vps.sh` rc 0, no output.
- **S2 mutation ledger (9 mutants, each reverted; tree byte-identical after):**

| mutant | change | result | caught by |
|--------|--------|--------|-----------|
| a | drop `10#` in fleetctl `box_index_from_name` | **CAUGHT** | `FAIL: D1 idx 008: [\|rc=1]` |
| b | `%03d`→`%d` in fleetctl copy only | **CAUGHT** | `FAIL: D1 name 8` + byte-identity |
| c | rename skips old `.line` delete | **CAUGHT** | `FAIL: rename F3 step6 …` |
| d | rename deletes BEFORE verify | **MISSED** | — (S2: `tunnel_up` stub never fails verify) |
| e | rename regenerates `~fleet` authorized_keys | **CAUGHT** | `FAIL: rename F6 authoritative … altered` |
| f | `flock -w 90`→`flock -n` | **MISSED** | — (S1: flock stub ignores args) |
| g | canary normalisation returns input unchanged | **CAUGHT** | `FAIL: rollout order wrong` |
| h | lexical sort restored in reconcile_target_boxes | **CAUGHT** | `FAIL: D5 numeric ordering wrong` |
| i | drop `10#` in boxup `box_index_from_name` | **CAUGHT** | `FAIL: box_index_from_name differs boxup/fleetctl` |

  Both MISSES are harness-stub gaps, not code defects (code is correct for both). Attachments
  with repro + the exact suite additions: `/data/cao-scratch/8a0d26ff/empirical-gate-attachments/
  {flock-wait-gap.sh, delete-last-gap.sh}`.

## S3 LIVE (VPS root@107.172.132.211; fleet-owned paths only)
- **Precondition:** enrolled 8,1,3,4,6,5,2,7,11; keys/ & boxes/ empty; `~fleet/.ssh/authorized_keys`
  sha **6f74e421…** (F6 baseline); timer active (dry-run, canary=grok-box-8); tunnels LISTEN for
  1,2,4,5,6,7,8,11 (3 offline). 9/10 online but NOT enrolled (out of scope, D7 defers to #10 retag).
  fleet-reconcile.service runs as ROOT (state root-owned) — rename must run as root.
- **S3.b deploy:** backed up `/opt/grok-fleet/fleetctl` → `fleetctl.bak.2bb78785.20260829T183042Z`;
  scp+sha-verify+installed branch fleetctl sha **5e3c1d41…**; `bash -n` OK. **Timer never touched.**
- **S3.c dry-run** `rename --dry-run grok-box-2 grok-box-002`: rc 0, printed 7-artefact plan + box
  command; enrolled.tsv sha and authkeys sha UNCHANGED; 0 grok-box-002 rows created.
- **Version-precheck (live):** with box boxup 5.2.0, `rename grok-box-2 grok-box-002` correctly
  ABORTED "runs boxup 5.2.0 (< 5.3.0); update boxup first"; no state mutation.
- **S3.d canary** grok-box-2 → grok-box-002: installed branch boxup 5.3.0 on the box (backup kept),
  then rename DONE rc 0 through all F3 steps. Verified: enrolled row `grok-box-002 20002`, old row
  gone; `grok-box-002.line`+`.checkfail` present, old gone; akmap rewritten (same key); tunnel 20002
  LISTEN; tailscale HostName=grok-box-002, DNS label grok-box-002; **authkeys sha UNCHANGED**; on-box
  `boxup check` rc 0 (`name=grok-box-002 v=5.3.0 tunnel=up`).
- **S3.e resumability kill-test** grok-box-1 → grok-box-001: `timeout --signal=TERM 2s` killed the
  rename right after the copy step. Post-kill: BOTH grok-box-1 AND grok-box-001 rows/`.line`/`.checkfail`/
  akmap present (same port 20001, same key), tunnel 20001 still LISTEN, reconcile lock free (released
  on death). Re-run logged `resuming — grok-box-001 state already copied; continuing from the box step`
  and completed. Final: exactly 1× grok-box-001 everywhere, 0× grok-box-1, no duplicates, authkeys UNCHANGED.
- **S3.f remaining awake boxes:** installed branch boxup then renamed
  **grok-box-4→004, grok-box-5→005, grok-box-6→006** — all DONE rc 0, clean DNS labels, on-box
  `boxup check` rc 0, authkeys UNCHANGED each time. SKIPPED asleep/offline: **grok-box-3** (offline),
  **grok-box-7** (slept mid-run — direct ssh timed out, boxup not upgradeable, so rename would refuse),
  **grok-box-11** (offline). Out-of-scope unenrolled: grok-box-9, grok-box-10.
- **reconcile_target_boxes numeric order (live):** `001,002,3,004,005,006,7,008,8,11` — index-sorted,
  legacy grok-box-3/7 interleaved at their indices. D5 ordering confirmed on the real enrolled.tsv.
- **S3.g two timer ticks (branch fleetctl):** `Result=success`, ExecMainStatus=0; every `config: pass
  done (dry-run) … failed=0`; `canary=grok-box-008` (D5 normalisation live); `identity: … legacy-name`
  for the un-renamed boxes and NOT for any grok-box-00N (D6 live); `identity: ok=10 flagged=1` (only the
  residual grok-box-8); NO `config push failing` notify. Timer stayed active every 5 min throughout.

## Box-8 open item (S3 finding — OPERATIONAL, needs your decision)
`fleetctl rename grok-box-8 grok-box-008` aborted twice (initial + resume) at the 60 s poll:
- The box applied the rename (os hostname, `$ROOT/hostname`, and tailscale **HostName** = grok-box-008,
  boxup 5.3.0) but its **MagicDNS DNSName label stays pinned to `grok-box-8`** (`grok-box-8.tail8ecb39.ts.net`).
- The rename's step-5 `POST /device/<id>/name` fired (no "POST failed" abort ⇒ HTTP 2xx) yet the label did
  not change within 60 s. On-box `boxup check` = **FAIL reason=name: dns=grok-box-8 want=grok-box-008**
  (kind=dns — the blueprint's "NOT fixable on-box" case).
- Per spec, the rename ABORTED and left BOTH grok-box-8 and grok-box-008 enrolled (same port 20008, same
  key) — resumable, tunnel never dropped, authkeys UNCHANGED. Reconcile ticks tolerate the dual row
  (dry-run, failed=0), flagging only grok-box-8 as legacy-name.
- **This is box-8-specific** (its label was pre-pinned/split per the blueprint Facts; 001/002/004/005/006
  all got clean labels). I stopped rather than invent a workaround (no manual row surgery, no forced
  re-registration). Options for you: (1) manually force/clear the tailnet DNS label for that node then
  re-run `rename` to let it finish; (2) reap the split node and let it re-enroll under the padded name;
  (3) accept the dual state until the node's DNS pin clears. A code-side follow-up worth considering:
  log the POST response body on the DNS timeout so this is diagnosable without a manual probe.

## VPS end state
- fleetctl = branch **5e3c1d41…**; backup `fleetctl.bak.2bb78785.20260829T183042Z` in place.
- `~fleet/.ssh/authorized_keys` sha = **6f74e421… (UNCHANGED from baseline)** — F6 held across all renames.
- enrolled.tsv: grok-box-001/002/004/005/006 (renamed) + grok-box-008 & grok-box-8 (box-8 dual, resumable)
  + grok-box-3/7/11 (asleep, unrenamed). Timer active.

## Final box table
| old | new | awake | outcome |
|-----|-----|-------|---------|
| grok-box-1 | grok-box-001 | yes | DONE (kill-test + resume) |
| grok-box-2 | grok-box-002 | yes | DONE (canary) |
| grok-box-4 | grok-box-004 | yes | DONE |
| grok-box-5 | grok-box-005 | yes | DONE |
| grok-box-6 | grok-box-006 | yes | DONE |
| grok-box-8 | grok-box-008 | yes | INCOMPLETE — DNS-label pin; both names valid/resumable |
| grok-box-3 | grok-box-003 | no (offline) | SKIPPED (asleep) |
| grok-box-7 | grok-box-007 | slept mid-run | SKIPPED (asleep; boxup not upgraded) |
| grok-box-11 | grok-box-011 | no (offline) | SKIPPED (asleep) |
| grok-box-9 / grok-box-10 | — | online | OUT OF SCOPE (not enrolled; D7 defers to #10 retag) |

Language: English. Scratch under /data/cao-scratch/8a0d26ff/ only; production server (:9889) untouched;
personal services / /root not read or audited.
