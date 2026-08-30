# fleetctl → fleet2 test coverage map (blueprint fleet-ts-phase3 D8 / F6)

Purpose: the parity oracle for retiring bash `fleetctl`. Every operator-command
assertion block in `tests/test-fleet-brain.sh` (bash source line ranges cited
against the pre-D8-step-1 file, i.e. commit `ddcd8a4`/`c303696` numbering as in
the fact pack) maps to its replacement:

- a `fleet/test/**/*.test.ts` test (named), OR
- a `tests/test-install-vps.sh` block (moved in D8 step 1, commit 1), OR
- `DROPPED: <bash-only mechanism>` — only for bash test-plumbing that has no
  behavioural analogue in the TS port.

`tests/test-iter3-fixes.sh` and `tests/test-boxup-config.sh` are boxup-side and
untouched by phase 3 — not in scope for this map.

Convention: bash line numbers are the `nl -ba` line of the `pass "…"` (or its
`case`/section) in the ORIGINAL 3965-line `tests/test-fleet-brain.sh` at
`c303696`. TS test names are the `describe > test` titles.

Legend for TS files:
- EXISTING = shipped by phase 1/2 (already in `fleet/test/`).
- NEW = added by phase 3 commit 3 under `fleet/test/commands/`.

---

## enroll (bash cmd_enroll main:1052-1215; §1B)

| bash block (line — name) | replacement |
|---|---|
| 50-74 authorized_keys line SHAPE (restrict, permitlisten 127.0.0.1:2000N) | NEW `fleet/test/commands/enroll.test.ts` › "T1 authorized_keys_line: restrict + permitlisten 127.0.0.1:<port>, no extra perms" |
| 206-239 ACL precheck: tagOwner present ⇒ 0 / absent ⇒ 1 (acl_test) | NEW `enroll.test.ts` › "T1 ACL precheck: tagOwners present ⇒ allowed; absent ⇒ REFUSE rc 1" |
| 240-297 BUG-D ts_api Accept: application/json on every call | EXISTING `fleet/test/tailscale.test.ts` › "tailscaleDevicesApi › GET hits the devices endpoint with Bearer + Accept" (Accept header is the TS transport's; the bash static-scan of ts_api is DROPPED: bash config-file builder mechanic) |
| 1697-1756 enroll_install_vps_authorized_key perms 700/600 + chown fleet (BUG-E) | NEW `enroll.test.ts` › "T1 VPS authorized_keys install: dir 700 / file 600 / chown fleet (BUG-E)" |
| 1775-1863 enroll_record_enrolled idempotency (two enrolls ⇒ one row) | NEW `enroll.test.ts` › "T1 enrolled.tsv idempotent: two enrolls ⇒ exactly one row (BUG-F prefix guard)" |
| 1889-1963 enroll_write_box_config fresh/existing/idempotent/port arms (D3b) | NEW `enroll.test.ts` › "T1 write_box_config: fresh appends / same values no-op / port arms (D3b)" |
| 1964-2000 D9 remote exit-4 (config ABSENT) vs transport failure | NEW `enroll.test.ts` › "T1 write_box_config: remote rc 4 ⇒ ABSENT branch; other rc ⇒ generic fail" |
| 2001-2033 D10 post-write read-back mismatch ⇒ write failure rc 1 | NEW `enroll.test.ts` › "T1 write_box_config: read-back mismatch ⇒ rc 1 (D10)" |
| 2034-2086 D8 partial-enroll: box-config FAIL ⇒ rc 1 + NOT recorded (m1) | NEW `enroll.test.ts` › "T1 cmd_enroll: box-config failure ⇒ rc 1, enrolled.tsv NOT written (m1)" |
| 2087-2173 D1 precheck: no VPS addr ⇒ 4-line refusal rc 1 before side effects | NEW `enroll.test.ts` › "T1 cmd_enroll: no VPS address ⇒ 4-line refusal rc 1, nothing written" |
| 3769-3810 enroll_wait_tunnel (D3/F1/F5): WAIT=0 skip / immediate / 3rd poll / WAIT=1 timeout rc4 / non-numeric warn+90 | NEW `enroll.test.ts` › "T1 enroll_wait_tunnel: WAIT=0 skip / up-now / up-3rd / WAIT=1 timeout rc 4 no-sleep / non-numeric ⇒ 90" |
| 3825-3846 enroll_permitlisten_verdict parses every token (F2) | NEW `enroll.test.ts` › "T1 permitlisten_verdict: allowed / unknown (rc1) / denied (rc2), every token parsed" |
| 3847-3897 cmd_enroll integration: F4 rc 6 locality, nothing written | NEW `enroll.test.ts` › "T1 cmd_enroll: rc 6 locality (fleet user absent) ⇒ nothing written" |
| 3898-3905 cmd_enroll: D4 rc 5 permitlisten DENIED, nothing written | NEW `enroll.test.ts` › "T1 cmd_enroll: rc 5 permitlisten DENIED ⇒ nothing written" |
| 3906-3913 cmd_enroll: D3 rc 4 tunnel timeout WITH enrolled.tsv row written | NEW `enroll.test.ts` › "T1 cmd_enroll: rc 4 tunnel timeout, row STILL written (resumable)" |
| 3914-3920 cmd_enroll: happy path WAIT=0 rc 0, row written | NEW `enroll.test.ts` › "T1 cmd_enroll: happy path (WAIT=0) rc 0, row written" |
| 3921-3926 cmd_enroll: F7 pre-existing listener WARNING (log-only, rc 0) | NEW `enroll.test.ts` › "T1 cmd_enroll: pre-existing listener ⇒ WARNING log-only, rc 0 (F7)" |

## mint-key (bash cmd_mint_key main:1649-1717; §1C — F1 THIN WRAPPER over actions/mint.ts)

| bash block (line — name) | replacement |
|---|---|
| 141-154 key_meta_file path keys/8.json (legacy index) | EXISTING `fleet/test/reconcile-tailscale-keys.test.ts` (key path via boxIndex) + NEW `fleet/test/commands/mint-key.test.ts` › "T2 key meta path grok-box-008 ⇒ keys/8.json" |
| 302-333 mint_payload shape (reusable/ephemeral/preauthorized/tags/expirySeconds) | EXISTING `reconcile-tailscale-keys.test.ts` › "mintPayload is the exact capabilities shape (main:1520-1526)" |
| 334-423 seed harness: sha mismatch ⇒ old key intact; ok path | EXISTING `fleet/test/seed-remote.test.ts` › "matching sha ⇒ installs…"; "sha mismatch ⇒ exit 3 … nothing installed" |
| 424-461 F3/D5b no-sudo guard (EACCES ⇒ rc 1) | EXISTING `fleet/test/actions-mint.test.ts` › "T5 mint rc map … rc 1 + REVOKE: seed/verify failure" (no-sudo is a seed failure arm) + NEW `mint-key.test.ts` › "T2 seed no-sudo (EACCES) ⇒ rc 1" |
| 462-482 E1 char-scan: seed_remote_script has NO apostrophe/backtick/# | EXISTING `actions-mint.test.ts` › "srs scan: SEED_REMOTE_SCRIPT has NO apostrophe/backtick/# comment" |
| 302-333 (payload 90-day clamp) + 1312-1336 P1-A/N1 clamp on BOTH payload arg AND .expires | EXISTING `reconcile-tailscale-keys.test.ts` › "clampExpirySecs [1, 7776000]" + NEW `mint-key.test.ts` › "T2 90-day clamp applies to payload AND .expires (P1-A, m14)" |
| 728-786 REVOKE-ON-FAILURE: exactly ONE DELETE, verbatim REVOKE line | EXISTING `actions-mint.test.ts` › "T5 mint rc map … rc 1 + REVOKE: seed/verify failure" + "T7 rotate ordering … revoke-miss" |
| 787-798 D5c seed rc 1 ⇒ revoke once, rc 1, no meta | EXISTING `actions-mint.test.ts` (rc 1 + REVOKE arm) |
| 799-821 S3 seed rc 3 (SEED_SHA_MISMATCH) ⇒ SEED arm revokes | EXISTING `actions-mint.test.ts` (seed/verify failure arm) + `seed-remote.test.ts` (exit 3) |
| 822-835 D5c 500-DELETE ⇒ RECONCILE_READONLY latch; 404 ⇒ rc1 not readonly | EXISTING `reconcile-tailscale-keys.test.ts` › "deleteKey (revoke) — 2xx or 404 ok … 500 not ok"; `actions-mint.test.ts` latch arms |
| 836-845 F7 record_key_meta FAILS ⇒ one DELETE, rc 1 (shared revoke helper) | EXISTING `actions-mint.test.ts` › "T5 mint rc map … rc 1 + REVOKE" (meta-persist arm) |
| 689-727 REAL cmd_mint_key meta file assertion | NEW `mint-key.test.ts` › "T2 cmd_mint-key wrapper: rc 0 writes meta + .expires LAST (F1)" |
| 1354-1379 P1-D/N5 record_key_meta REFUSES blank id | EXISTING `actions-mint.test.ts` (T5 mint_window_valid / meta arms) + NEW `mint-key.test.ts` › "T2 record_key_meta refuses blank id (N5)" |
| 1408-1446 P1-B/N6 run-wide read-only latch suppresses later mutation | EXISTING `fleet/test/reconcile-run.test.ts` › "T2 latch suppresses a mint-worthy box even in apply mode (m2)" |
| usage arms (main:1651-1652): empty ⇒ rc 2, non-grok ⇒ rc 2 (F1 split) | NEW `mint-key.test.ts` › "T2 usage: empty ⇒ 'usage: fleet2 mint-key' rc 2; non-grok ⇒ 'refusing non-grok' rc 2 (m15)" |

## rename (bash cmd_rename main:3670-3848; §1E)

| bash block (line — name) | replacement |
|---|---|
| 3515-3521 non-canonical `<new>` ⇒ rc 2 | NEW `fleet/test/commands/rename.test.ts` › "T3 validation: non-canonical <new> ⇒ rc 2" |
| 3522-3528 index change ⇒ rc 2 | NEW `rename.test.ts` › "T3 validation: index change ⇒ rc 2 (rename never changes port)" |
| 3529-3532 boxup < 5.3.0 ⇒ ABORT | NEW `rename.test.ts` › "T3 precheck: boxup < RENAME_MIN_BOXUP_VERSION ⇒ ABORT rc 1" |
| 3533-3537 lock busy (flock -w 90) ⇒ 'reconcile busy' rc 1 | NEW `rename.test.ts` › "T3 lock: flock -w 90 busy ⇒ 'reconcile busy … 90s' rc 1 (m6)" |
| 3543-3552 --dry-run plan lines + enrolled.tsv NOT mutated | NEW `rename.test.ts` › "T3 --dry-run: plan lines printed, enrolled.tsv untouched" |
| 3588-3592 F6 ~fleet/.ssh/authorized_keys NEVER touched | NEW `rename.test.ts` › "T3 authoritative ~fleet/.ssh/authorized_keys never touched (F6/F11)" |
| 3593-3624 copy-first state move + box step + verify happy path | NEW `rename.test.ts` › "T3 happy path: copy-first (7 artefacts incl .toml), box step, verify, delete-old" |
| 3625-3631 resume after step-2 copy (F3) | NEW `rename.test.ts` › "T3 resume: <new> state already copied ⇒ continue from box step" |
| 3632-3650 S2/F3 failed post-rename verify leaves OLD state INTACT (m5) | NEW `rename.test.ts` › "T3 verify FAIL ⇒ OLD state intact, not deleted (m5)" |
| F11 .toml overlay copied@2/deleted@6; render(new)==render(old) | NEW `rename.test.ts` › "T3 managed .toml overlay moves with the box (render(new)==render(old))" |

## config render|diff|push (bash cmd_config main:3326-3404; §1D — reuse actions/config-push.ts pushManaged + managed/*)

| bash block (line — name) | replacement |
|---|---|
| 2386-2389 D5 first push writes managed.toml rc 0 | EXISTING `fleet/test/managed.test.ts` › "T11 push_managed rc classifier … dry-run in-sync ⇒ 0 / apply write" + NEW `fleet/test/commands/config.test.ts` › "T4 push: first push rc 0" |
| 2390-2395 D5 identical ⇒ in-sync no-op rc 0 | NEW `config.test.ts` › "T4 push: identical ⇒ no-op rc 0" |
| 2396-2400 D5 dry-run WOULD push writes nothing | NEW `config.test.ts` › "T4 diff/dry-run: writes nothing" |
| 2401-2424 D5 truncated stdin ⇒ rc 3 file unchanged | EXISTING `managed.test.ts` › "sha mismatch ⇒ exit 3 … nothing written" + NEW `config.test.ts` › "T4 push: truncated stdin ⇒ rc 3, on-box unchanged" |
| 2425-2430 enabled=false NOTE / support=no NOTE | EXISTING `managed.test.ts` (status annotations) + NEW `config.test.ts` › "T4 diff: enabled=false NOTE / support=no NOTE verbatim" |
| 2769-2786 D7 cmd_config refuses un-enrolled box rc 2 | NEW `config.test.ts` › "T4 not enrolled ⇒ rc 2 refusing" |
| 2787-2820 D7 diff exit codes + IGNORED annotation | NEW `config.test.ts` › "T4 diff rc: in-sync 0 / drift 1; IGNORED annotation" |
| 3040-3108 canary rc 6 via real push_managed (fake ssh rc 255) | EXISTING `managed.test.ts` › "m7: canary rc 6 (transport) ⇒ skip canary + fall through" |
| 3109-3136 D11b absent-[managed] key ⇒ enabled=true, diff IN SYNC rc 0 | NEW `config.test.ts` › "T4 diff: absent [managed] key ⇒ enabled=true, IN SYNC rc 0 (D11b)" |
| 3240-3277 E2 rc classifier | EXISTING `managed.test.ts` › "T11 push_managed rc classifier (E2, tests:3240-3277)" |
| 3384-3385 diff output byte-equals `diff -u --label` fixture (F12) | NEW `config.test.ts` › "T4 diff: output byte-equals diff -u --label fixture; empty on-box ⇒ one blank line (F12)" |
| diff(1) absent ⇒ 'config diff: diff(1) not found' rc 2 (F12) | NEW `config.test.ts` › "T4 diff: diff(1) missing ⇒ rc 2 (F12)" |

## fleet-status (bash cmd_fleet_status main:3410-3437; §1D)

| bash block (line — name) | replacement |
|---|---|
| 3410-3437 header + rows (API/TUNNEL/CHECK/AUTHKEY/VERSION), CHECK gated on tunnel up (m13) | NEW `fleet/test/commands/fleet-status.test.ts` › "T5 fleet-status golden table; CHECK not probed when tunnel down (m13); API '?' on failure" |

## list / ssh (bash cmd_list main:218-229, cmd_ssh main:694-712; §1A/F8/F15)

| bash block (line — name) | replacement |
|---|---|
| list header `%-14s %-16s %-6s` + rows + empty-fleet line (main:220,228) | NEW `fleet/test/commands/list.test.ts` › "T5 list golden table; empty fleet ⇒ '(no grok-box-N peers found on the tailnet)'" |
| ssh usage rc 2 (main:696-699) | NEW `fleet/test/commands/ssh.test.ts` › "T-ssh usage: no box ⇒ rc 2" |
| ssh password via child env only, never argv/log/parent env (M11/F15, main:206-215) | NEW `ssh.test.ts` › "T-ssh SSHPASS only in child env; parent process.env.SSHPASS undefined; argv carries no password (m10/m18)" |

## status / check / rollout — re-based on phase 1 (D3/F2/F9/M2/M4)

Note: D3 declares these are NOT bash-verbatim; their bash §1A strings/rc-maps
are superseded (F8). Their re-based behaviour is covered by the phase-1 engine
tests plus new alias/locality tests.

| bash block (line — name) | replacement |
|---|---|
| 484-524 reconcile_decide rows a–e + healthy | EXISTING `fleet/test/reconcile-decide.test.ts` › "T1 reconcile_decide (tests:484-523)" (all rows) |
| 525-540 read-only on API failure ⇒ no mutation | EXISTING `reconcile-decide.test.ts` + `reconcile-run.test.ts` › "T2/latch: failed GET ⇒ READ-ONLY" |
| 555-585 API-failure read-only run emits NO mutation | EXISTING `reconcile-run.test.ts` › "T2/latch: non-2xx GET ⇒ latch + read-only log" |
| 583 dev_field live_id | EXISTING `tailscale.test.ts` › "parseDevices … live_id / corpse fold" |
| 615-688 ROTATE reconcile_rotate ordering (mint then revoke old) | EXISTING `actions-mint.test.ts` › "T7 rotate ordering + revoke-miss (tests:623-685)" |
| 846-954 ROLLOUT canary-first / abort-on-first-failure / canary default | EXISTING `fleet/test/upgrade.test.ts` › "T5 upgrade order … m1 canary verified-failure ABORT / m12 canary tunnel-down ABORT" |
| 955-971 canary default grok-box-008 (bash) → resolved canary (F9) | NEW `fleet/test/commands/rollout-alias.test.ts` › "T6 rollout: canary=<resolved> policy=config|dynamic (F9), NOT hardcoded 005" |
| 972-1011 tunnel_deploy_one ssh argv + no key in argv (was §1A) | EXISTING `fleet/test/tunnel.test.ts` › "T2 tunnel argv is exact"; `upgrade.test.ts` deploy path |
| 1380-1407 P2-A/N3 tunnel_deploy_one push-less guard (fact-pack §4 mislabels as install-vps) | EXISTING `upgrade.test.ts` staging guard + NEW `rollout-alias.test.ts` › "T6 push-less deploy refused, zero transport (N3)" |
| bare rollout ⇒ 3-line refusal rc 2 (F9, main:636-639) | NEW `rollout-alias.test.ts` › "T6 bare rollout ⇒ 3-line refusal rc 2 (fleet2 spelling)" |
| --dirty accepted, logged compat line, no refusal (M4) | NEW `rollout-alias.test.ts` › "T6 --dirty accepted + compat log, no refusal (M4)" |
| VPS-only locality rc 6 for status/check/rollout/inventory/upgrade (F2/M2) | NEW `fleet/test/commands/locality.test.ts` › "T-locality: no FLEET_BOX_KEY ⇒ rc 6 + VPS-only line for all five spellings (M2)" |
| check --notify ⇒ rc 1 + one Telegram line 'check: N unhealthy: <boxes>' (F5) | NEW `fleet/test/commands/check.test.ts` › "T6 check --notify: FLEET_BOXES override unhealthy ⇒ rc 1, one notify line" |
| status summary lines re-emitted from inventory (F2 Q1 addendum) | NEW `fleet/test/commands/status-alias.test.ts` › "T6 status: MIXED-version / drift summary from resolved target sha" |

## usage / dispatch / version (bash main:3440-3491, 3850-3874; §1D/§7 — F10)

| bash block (line — name) | replacement |
|---|---|
| dispatch: bare/`-h`/`help` ⇒ usage stdout rc 0 (F10) | NEW `fleet/test/commands/dispatch.test.ts` › "T6 dispatch: bare/-h/help ⇒ usage on stdout rc 0" |
| dispatch unknown ⇒ 'fleet2: unknown command: <cmd>' + usage on STDERR rc 2 (m11) | NEW `dispatch.test.ts` › "T6 dispatch: unknown ⇒ stderr usage + rc 2 (m11)" |
| version ⇒ `fleet2 5.4.0 (<sha>) (bun <v>)` | EXISTING `fleet/test/version.test.ts` (sha resolution) + NEW `dispatch.test.ts` › "T6 version string shape 5.4.0" |
| every documented subcommand dispatches | NEW `dispatch.test.ts` › "T6 every documented subcommand is routed" |
| usage() §7 text (fleetctl→fleet2, D3/D6 lines adjusted) | NEW `dispatch.test.ts` › "T6 usage text: fleet2 wording, remove-timer line, no install-timer line (M5)" |

## timers (bash cmd_install_timer/cmd_remove_timer main:724-760; D6/F7/M5)

| bash block (line — name) | replacement |
|---|---|
| install-timer retired ⇒ rc 2 verbatim line (D6) | NEW `fleet/test/commands/timers.test.ts` › "T6 install-timer ⇒ retirement line rc 2" |
| remove-timer no systemctl ⇒ rc 1 'systemctl not found' (M5) | NEW `timers.test.ts` › "T6 remove-timer: no systemctl ⇒ rc 1" |
| remove-timer with fake systemctl ⇒ both units removed, daemon-reload, verbatim log rc 0 (M5) | NEW `timers.test.ts` › "T6 remove-timer: removes both units + daemon-reload + verbatim log rc 0" |

## D4 WOULD-prefix (bash main:2871-2872; F3)

| bash block (line — name) | replacement |
|---|---|
| 525-540 read-only WOULD suppression (bash bug preserved in phase 2) | EXISTING `reconcile-run.test.ts` › "H2: WOULD line 'read-only ' prefix is UNCONDITIONAL" (REPLACED in D4 commit by T7) |
| D4 healthy dry-run ⇒ '(dry-run/no-apply)'; latched ⇒ '(read-only dry-run/no-apply)'; config-pass WOULD line no prefix | NEW `reconcile-run.test.ts` (amended) › "T7 D4: healthy dry-run no 'read-only '; latched has it; config-pass WOULD unprefixed (m9, m16)" |

## install-vps.sh assertions (moved in D8 step 1, commit 1)

| bash block (line — name) | replacement |
|---|---|
| 1117-1185 INSTALLER idempotency/tree/dry-run/uninstall/scope-guard | `tests/test-install-vps.sh` INSTALLER section |
| 1345-1403 M19/M20/M21 installer mutant kills | `tests/test-install-vps.sh` INSTALLER MUTANT KILLS section |
| 3656-3768 #12 D6a/D6b/#11/F10 sshd drop-in | `tests/test-install-vps.sh` PermitListen cap section |
| 3927-3962 F8 sshd reload FATAL | `tests/test-install-vps.sh` F8 block |
| BUG-A (installer) 1535-1550 Environment=HOME= unit template | `tests/test-install-vps.sh` (T8 ExecStart/env — folded into service-unit assertions) OR EXISTING coverage; see note* |
| BUG-E (installer) 1635-1643 ensure_fleet_user chown ~fleet/.ssh | `tests/test-install-vps.sh` (installer scope) OR DROPPED if not an installed-artefact assertion; see note* |

\*note: BUG-A/BUG-E installer static scans that were NOT part of the four moved
blocks stay in `test-fleet-brain.sh` until commit 7; if they assert installed
artefacts they migrate to `test-install-vps.sh` in the D7 installer-rewrite
commit (commit 6, T8), else they are DROPPED with the fleetctl static-scan
mechanism named. Finalised before the deletion commit.

## DROPPED — bash-only test plumbing (no behavioural analogue)

| bash block (line — name) | DROPPED reason (bash mechanism) |
|---|---|
| 37-45 `extract_from` / `fc` / `bx` awk function extractor | DROPPED: bash `awk` source-extraction harness; TS imports modules directly, no extraction needed. |
| 96-139 "run a helper from EITHER file" byte-identical boxup==fleetctl check | DROPPED: bash `local -A`/dual-file byte-identity of shell functions; fleet2 has a single `boxes.ts` (`boxIndex`/`portFor`) — identity is structural, covered by `fleet/test/boxes.test.ts`. |
| 156-205 pick_name / reconcile_target_boxes ordering via python fixture stub | Partially EXISTING `boxes.test.ts` (`resolveMembership`, numeric order); the `pick_name` python-stub mechanic is DROPPED: boxup-side name minting, not a fleetctl operator command. |
| 293-298 static: Accept header must be in ts_api config builder | DROPPED: bash `--config` file-builder string scan; TS sets the header in `tailscale.ts` transport (covered by tailscale.test.ts). |
| 355-372 REAL wrapping harness (record remote cmd, run through real shell) | DROPPED: bash `sudo`-shim/PATH-shadow test plumbing; TS tests wrap via FakeRunner recording argv directly. |
| 1124-1158 M01 cmd_reconcile default apply=0 | EXISTING `reconcile-run.test.ts` › "dry-run emits … no enrolled boxes ⇒ rc 0" (default is dry-run) — mechanic (extract cmd_reconcile) DROPPED, behaviour kept. |
| 1159-1189 M02 defeat readonly suppression | EXISTING `reconcile-run.test.ts` › "T2 latch suppresses a mint-worthy box even in apply mode (m2)". |
| 1190-1214 M03 stale-device selector picks OLDER OFFLINE | EXISTING `tailscale.test.ts` › "parseDevices … -1 corpse folds"; `reconcile-decide.test.ts` row b. |
| 1215-1247 M11 auth key never in remote ssh ARGV | EXISTING `actions-mint.test.ts` › "M11: the minted key value never appears in any recorded ssh argv or log line". |
| 1248-1274 M13 seeded auth key chmod 600 | EXISTING `seed-remote.test.ts` (installs key; mode is in SEED_REMOTE_SCRIPT) — the bash `stat -c%a` file-mode scan is DROPPED (script constant is E1-scanned identical). |
| 1275-1303 M23 API-failure notify at 3rd consecutive | EXISTING `reconcile-run.test.ts` (api.fails bump) + `reconcile-alerts.test.ts`. |
| 1337-1353 P1-C/N2 devices_json_valid fail-closed | EXISTING `tailscale.test.ts` › "malformed / non-array body → empty map, never throws". |
| 1447-1534 BUG-A/BUG-B set -u / HOME / exec-stderr footguns (fleetctl) | EXISTING `reconcile-bugb.test.ts` (locked child stderr reaches parent); the bash `env -i`/`$HOME` static scans are DROPPED: shell-specific `set -u`/`exec N>` footguns with no TS analogue (bun has no equivalent redirection footgun). |
| 1551-1562 Footgun sweep `exec N>… 2>/dev/null` in fleetctl | DROPPED: bash file-descriptor-redirection source scan; no TS analogue. |
| 1563-1625 BUG-E post-write ~fleet/.ssh dir 700 (fleetctl side) | Covered by NEW `enroll.test.ts` VPS authorized_keys perms test; bash static var scan DROPPED. |
| 1644-1739 BUG-F reconcile_alert_asleep set -u crash + dedup | EXISTING `reconcile-alerts.test.ts`; the `set -u` crash reproduction is DROPPED (shell-specific). |
| 2431-2498 BLOCKER-2 remote managed-status probe invokes boxup config-get | EXISTING `managed.test.ts` › "T11 managed_remote_script (mrs_scan E1)" + parseStatusTokens. |
| 2499-2584 D6 reconcile_config_pass silent no-op / threshold notify / per-box guard | EXISTING `managed.test.ts` › "T11 config pass canary routing (F1/F2)". |
| 2584-2708 #14 tunnel-DOWN canary counted skipped / BLOCKER-1 checkfail count | EXISTING `managed.test.ts` › "m6: non-canary checkfail>3 ⇒ skipped"; canary skip line. |
| 2709-2768 D4 forward-compat info log (unknown key allowed once) | EXISTING `managed.test.ts` › "known + unknown-but-well-formed keys allowed"; `unknownManagedKeys`. |
| 2821-2872 D9 cfgfail bump/reset + notify at >3 | EXISTING `managed.test.ts` (m8 canary content-fail cn>3 ⇒ notify) + `reconcile-run.test.ts` D6c. |
| 2873-3039 D11b canary-unreachable fall-through / content-failure | EXISTING `managed.test.ts` › "m7 canary rc 6 … fall through"; "no reachable box ⇒ … non-canary loop still runs". |
| 3137-3174 D6c failing config pass must not change run rc | EXISTING `reconcile-run.test.ts` › "T13 D6c: config pass failure never changes run rc". |
| 3175-3316 EMPIRICAL r5.1 apostrophe scan of managed_remote_script | EXISTING `managed.test.ts` mrs_scan (E1) + `actions-mint.test.ts` srs_scan. |
| 3317-3410 legacy-name detection / -1 split-brain fold (fleet_dedup) | EXISTING `tailscale.test.ts` baseName fold + `reconcile-decide.test.ts`. |

---

## Count reconciliation

- Operator-command NEW TS tests live under `fleet/test/commands/`:
  `enroll.test.ts`, `mint-key.test.ts`, `rename.test.ts`, `config.test.ts`,
  `fleet-status.test.ts`, `list.test.ts`, `ssh.test.ts`, `check.test.ts`,
  `rollout-alias.test.ts`, `status-alias.test.ts`, `locality.test.ts`,
  `dispatch.test.ts`, `timers.test.ts`. (T1–T8 of blueprint §2.)
- Every block above resolves to EXISTING, NEW, `test-install-vps.sh`, or DROPPED
  with a named bash mechanism.
- The mandatory fact-pack §4 blocks (504-508 row-b, 528+ readonly_test, 555
  api-failure, 583 dev_field live_id, 2713+ #14 canary counting, 2999-3000 D9
  notify call-site, 3140+ D6c guard) each resolve to a NAMED existing TS test
  above (reconcile-decide / reconcile-run / tailscale / managed).

This map is the parity oracle; the D8-step-2 deletion commit (commit 7) cites
its sha256.
