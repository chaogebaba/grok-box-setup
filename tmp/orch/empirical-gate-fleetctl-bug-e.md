**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/empirical-gate-fleetctl-bug-e.md
**Artifact-SHA256:** (self; computed post-write below)
**Artifact-Repo-Path:** tmp/orch/empirical-gate-fleetctl-bug-e.md
**Git-SHA-fork:** 76d45e5d29b4f0cca965b40e4f863646377a7409

# EMPIRICAL GATE + LIVE CANARY — fleetctl BUG-E fix

- Subject: `fix/fleetctl-bug-e` @ 76d45e5 (worktree /home/chao/VScode_projects/fleet-fix-e; base main 7c80fec)
- Pins: all 4 VALID at start AND end (fleetctl, vps/install-vps.sh, tests/test-fleet-brain.sh, docs/FLEET-BRAIN.md)
- VPS canary: root@107.172.132.211 (gppamxvx.colocrossing.cloud)

## VERDICT: PASS — 0 BLOCKER / 0 SHOULD / 0 NIT

The fix is correct and empirically proven both box-free and live. BUG-E was
reproduced on the real VPS (sshd privsep "Could not open user 'fleet'
authorized keys ... Permission denied", tunnel down) and the fixed `fleetctl
enroll` restored fleet:fleet 600 / dir 700, sshd "Accepted publickey for
fleet", and a working 20008 tunnel (`boxup check`=OK). Mutation coverage is
adequate: 3 of 4 mutants are caught by named tests; the 1 survivor (M2) is a
behaviorally-equivalent no-op, not a coverage gap that hides a defect.

### Findings (one line each)
- (none) No BLOCKER/SHOULD/NIT. Fix, tests, docs, and live behavior all consistent.

## STAGE 1 — box-free (all on scratch copies; working tree byte-identical after)

- `bash tests/test-fleet-brain.sh` → **101 PASS / 0 FAIL, exit 0** (matches claim).
- `make lint` (bash -n over boxup, fleetctl, install.sh, box-bootstrap.sh, vps/install-vps.sh) → **exit 0, clean**.
- Writer coverage: only ONE real writer of `$FLEET_VPS_AUTHKEYS` — `mv -f "$tmp" "$FLEET_VPS_AUTHKEYS"` at fleetctl:1065 inside `enroll_install_vps_authorized_key`; `ensure_vps_authkeys_perms` is called immediately after at :1067. grep of all `FLEET_VPS_AUTHKEYS` refs confirms no other write path. COVERED.
- Installer test (`chown -R "$FLEET_USER":"$FLEET_USER" "$home/.ssh"`) asserts a line that PRE-EXISTS in the pinned install-vps.sh:138 (not introduced by this diff) — assertion valid, passes.

### Mutation ledger (scratch copy of full repo dir; test ROOT resolves to scratch)
| ID | Mutation | Result | Named test flipped / rationale |
|----|----------|--------|-------------------------------|
| M1 | delete `chown -R $FLEET_VPS_USER...` line | **CAUGHT** (exit 1) | "BUG-E: enroll chowns ~fleet/.ssh authorized_keys to fleet:fleet" → FAIL |
| M2 | reorder chown BEFORE the two chmods | **SURVIVOR** | Behaviorally equivalent: chown touches owner only, chmod touches mode only — orthogonal; identical final state (dir 700, file 600, fleet-owned). The "Owner LAST" comment guards a hazard (chmod clobbering owner) that cannot occur. NOT a blocker. |
| M3 | hardcode `fleet:fleet` literal | **CAUGHT** for the configurability contract | Full literal mutant (literal in chown + replace the `FLEET_VPS_USER="${...}"` declaration) → "BUG-E: FLEET_VPS_USER is a configured var" FAILS (exit 1). Body-only literal with the var still at its default is a benign partial survivor (no behavioral difference when FLEET_VPS_USER=fleet). |
| M4 | drop the dir `chmod 700 "$akdir"` | **CAUGHT** (exit 1) | "BUG-E: enroll chmods ~fleet/.ssh dir 700" → FAIL |

Baseline-relative integrity: `git status --short` empty and all 4 in-scope
file sha256 identical to the start-of-review baseline. No product/test/doc/
blueprint edits.

## STAGE 2 — live canary (root@107.172.132.211)

Pre-flight: backed up `/opt/grok-fleet/fleetctl` → `/root/fleetctl.bak.1787963386`.
Deployed the pinned fleetctl over it; on-VPS sha256 =
`a01df1d6b701d7af446c025bf9ad9c217bbd8e7e2e7fed07ddeb7338d08ce18a` = PIN. ✔

(a) REPRODUCE — `chown root:root /home/fleet/.ssh/authorized_keys`, killed the
20008 tunnel client. On box-8 autossh reconnect, sshd logged:
```
sshd[113058]: Could not open user 'fleet' authorized keys '/home/fleet/.ssh/authorized_keys': Permission denied
sshd[113058]: Connection closed by authenticating user fleet ... [preauth]
```
20008 NOT listening. **BUG-E reproduced.** ✔

(b) FIX — real `FLEET_SSH_PASSWORD=... fleetctl enroll grok-box-8` (re-enroll of
already-enrolled box) → "installed VPS fleet authorized_keys line for
grok-box-8 (permitlisten 127.0.0.1:20008)", "DONE".
- Post-enroll: `/home/fleet/.ssh` = fleet:fleet 700; `authorized_keys` =
  fleet:fleet 600 (was root:root). ✔
- On next reconnect, sshd: **`Accepted publickey for fleet from ... (uid=996)`**. ✔
- **127.0.0.1:20008 listening** (sshd pid). ✔
- Tunnel functional: `ssh -i /etc/grok-fleet/box_access_ed25519 -p 20008 box@127.0.0.1 'sudo boxup check'`
  → `check=OK backend=Running online=yes sshd=up ... name=grok-box-8 v=5.2.0/0feab2e tunnel=up`, exit 0. ✔
  (Note: brief's `box_access` = actual path `/etc/grok-fleet/box_access_ed25519`; boxup at `/workspace/box-setup/boxup`.)

(c) RECONCILE — `systemctl start fleet-reconcile.service`: Result=success,
ExecMainStatus=0. Journal shows visible DRY-RUN rows for ALL 5 boxes:
```
reconcile: start (DRY-RUN)
grok-box-1/3/4/6/8 WOULD mint (read-only dry-run/no-apply)
reconcile: done (DRY-RUN)
```
exit 0, apply=false confirmed. ✔

(d) FINAL INTEGRITY —
- `sshd -t` clean ("sshd config OK"). ✔
- Config hashes UNCHANGED vs baseline: sshd_config, /usr/local/etc/xray/config.json,
  hysteria/config.yaml, wireguard/wg0.conf, sshd_config.d/{50-cloud-init,50-grok-fleet}.conf
  — all byte-identical. ✔
- Services: xray=active, hysteria-server=active, wg-quick@wg0=active, wg0 iface present. ✔
- All 5 tunnels listening: 20001, 20003, 20004, 20006, 20008. ✔
- fleet-status: grok-box-8 tunnel now `up`/CHECK OK (was `down`/`-`); all 5 tunnels `up`.
  (API column `offline` is pre-existing Tailscale-API reachability state, unrelated to
  the tunnel path BUG-E governs — unchanged.)
- No new boxes enrolled, no mint-key, nothing with --apply, no hand edits to fleetctl. ✔

## Empirical checks (RAN — observed, not inferred)
1. test-fleet-brain.sh → 101 PASS / exit 0 (observed).
2. make lint → exit 0 (observed).
3. M1..M4 mutants on scratch → results in ledger above (observed exit codes + flipped test names).
4. Live: root-owned authorized_keys → sshd "Permission denied" + tunnel down (observed journal).
5. Live: fixed enroll → fleet:fleet 600/700 + "Accepted publickey for fleet" + 20008 up + boxup check=OK (observed).
6. Live: reconcile DRY-RUN 5 rows + exit 0 (observed journal).
7. Live: config hashes identical, sshd -t clean, 5 tunnels up (observed).

## State left on VPS
- Fixed fleetctl deployed at /opt/grok-fleet/fleetctl (sha256 = pin) — the intended post-fix state.
- Backup retained at /root/fleetctl.bak.1787963386 (pre-fix, restorable).
- ~fleet/.ssh/authorized_keys restored to fleet:fleet 600 by the real enroll (healthy).

## Scratch
- Local scratch: /data/cao-scratch/715ec3be (repo copy for mutants + baseline hashes). No product edits.
