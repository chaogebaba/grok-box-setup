**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/design-review-enroll-one-step-r3.md
**Artifact-SHA256:** 6fd1a37a21b3d6090b3b4eb9c2ddd8d2756c05ffa284bb9b3f648083758733eb
**Artifact-Repo-Path:** tmp/orch/design-review-enroll-one-step-r3.md
**Git-SHA-root:** 58895efa59df9c9e67deea9b5738d3caafe4f620

# DESIGN GATE r3 — feat/enroll-one-step

(Artifact-SHA256 above is the pinned BLUEPRINT's sha, per the frozen-pin block, for
provenance; this memo file's own hash differs.)

## VERDICT HEADER

**Result: PASS** — 0 BLOCKER / 0 MAJOR / 3 MINOR.
**Zero-decision buildable: YES.** The decision wall D0–D10 is complete and internally
coherent; the built diff (main 89207af → 58895ef) implements every decision as written.
The three MINORs are documentation/cosmetic and do not gate the design.

Frozen pins verified VALID at task start AND immediately before this callback
(blueprint + diff). Working tree captured clean at review start; review was read-only
(`git show 58895ef:*` only); no tree mutation.

Findings (one line each):
- MINOR-1 (D1 wording): blueprint D1 says "REMOVE any hardcoded FLEET_VPS_ADDR_DEFAULT /
  changes to any EXISTING fleet_vps_addr helper" — base 89207af had NO such helper/global
  (greenfield). Diff correctly adds the helper with no baked default; wording is
  retrospective-only. Amendment: none required; note "greenfield, no prior helper".
- MINOR-2 (doc drift): config.example.toml:63 example `#vps = "203.0.113.10"` and
  install-vps.sh template `#vps = "203.0.113.10"` use TEST-NET-3 placeholders while
  FLEET-BRAIN.md §1/§ops still name the literal `107.172.132.211` in prose. Cosmetic;
  both are valid (real address in doctrine prose, placeholder in shipped templates).
- MINOR-3 (empirical, not design): D3 remote-script stdin delivery + the D10 read-back's
  deeply-nested awk quoting are correctness-critical and cannot be settled by reading —
  hand to the EMPIRICAL gate (see "Checks for the empirical gate").

## RULING DETAIL

**(1) Decision wall complete & internally coherent — YES.**
- D0/D7 mechanism (on-box single `sudo sh -s`, awk transform, `cmp -s` no-op, chmod 600
  before `mv -f`) is implemented in `enroll_write_box_config` (diff fleetctl new fn, the
  `+enroll_write_box_config()` hunk). Supersedes r2-D7 brain-side cat/tee — single round
  trip, no TOCTOU. Coherent.
- D1 section separation is the load-bearing coherence point and it HOLDS: brain reads
  `[fleet-brain].vps` (OBSERVED: diff `fleet_vps_addr()` → `config_get fleet-brain vps`);
  box reads `[fleet].vps` (OBSERVED: boxup:965 `config_get fleet vps`). No section
  collision. `[fleet-brain]` is consistent with api_token_file/rollout_src/canary_box.
- D3 three states (a active-replace / b comment-insert / c header-append) + no-op
  byte-compare + no-duplication + mode 600 are each realized by the two-pass awk
  (PASS 1 records active keys so a commented-key insert never fires when an active line
  exists — the duplication guard). The "never bare keys at EOF" rule is well-founded:
  OBSERVED boxup:216-219 binds an un-headed key to the last-seen `[table]` (`sec` set only
  by a header line), so appending header+keys (state c) is the correct shape.
- D3b port omit-at-22: OBSERVED boxup:967 `sshport=...; [ -n ] || sshport=22` — box
  default is genuinely 22, so omitting the key when resolved==22 is safe. `want_port=""`
  correctly drives DROP-active / add-none. Coherent.
- D8 ordering: box-config write is the LAST side effect before `enroll_record_enrolled`
  (OBSERVED diff cmd_enroll: write block precedes the record call); failure logs WARNING,
  does NOT record, returns 1, leaves VPS key (idempotent retry). Coherent.
- D9 exit-4 vs transport: `enroll_write_box_config` returns 4 VERBATIM only for the remote
  "config not found" exit; any other non-zero (incl. transport 255) → 1. cmd_enroll maps
  ONLY rc=4 to "run install.sh first". Distinction is preserved end-to-end. Coherent.
- D10 read-back: vps + box_index always, port only when written; mismatch → return 1
  (treated as write failure). Present in the diff. Coherent.
- D4 flag: `--no-box-config` parsed order-independently BEFORE the positional
  (while-loop collects `rest[]`, then `set -- "${rest[@]}"`); box name still validated
  `^grok-box-`. Coherent.

**(2) Every decision implemented — YES (per-decision cites):**
- D0/D7 → fleetctl `+enroll_write_box_config()` (remote `sh -s` script, awk, cmp, chmod,
  mv -f); wired in cmd_enroll between `enroll_install_box_authorized_key` and
  `enroll_record_enrolled` (diff cmd_enroll "(5) close the two-part-enroll gap" hunk).
- D1 → fleetctl `+fleet_vps_addr()` (env>`[fleet-brain].vps`>refuse, no default) + cmd_enroll
  "(0) PRECHECK" block (refuse before any side effect). Tests: `vpsaddr_test env/config/
  default`, static "FLEET_VPS_ADDR_DEFAULT is DELETED", `d1_precheck_test` (zero side
  effects on refuse). Migration doc: install-vps.sh template `#vps`/`#vps_port`,
  FLEET-BRAIN.md §ops "One-time migration for EXISTING brains".
- D2 → reuses `box_index`/`port_for` (OBSERVED fleetctl:851/859 exist; cmd_enroll calls
  `box_index "$box"`).
- D3 → the two-pass awk in `enroll_write_box_config`. Tests: seedA (comment-insert),
  seedB (active-replace), seedC (header-append), noop byte-compare, mode 600, fleet_hdr=1.
- D3b → fleetctl `+fleet_vps_port()` + `want_port` gating. Tests: `vpsport_test`, port22
  omit, port2222 insert/replace, drop-active-22.
- D4 → cmd_enroll flag-parse loop + usage string. Tests: `noboxcfg_test before/after/none`.
- D5 → tests/test-fleet-brain.sh +425 lines covering a/b/c, no-op, no-dup, mode, flag,
  D8 contract, D9 exit-4 vs transport, D1 refuse, D3b port-iff-non-22. (Suite green claim
  is EMPIRICAL — see below; NOT asserted here.)
- D6 → DESIGN.md:171 qualifier (OBSERVED, present), config.example.toml:57-84 [fleet]
  comment, install-vps.sh template `[fleet-brain].vps`/`vps_port`, FLEET-BRAIN.md §1/§ops.
- D8 → cmd_enroll rc handling + `d8_test 1/4/0` (not-recorded on 1/4, recorded on 0).
- D9 → `enroll_write_box_config` rc-4 passthrough + `d9_test absent/transport`.
- D10 → read-back asserts + `d10_test` (lie-on-read-back → rc 1).

**(3) Precedent / fleetctl conventions — CONSISTENT.**
- `config_get <table> <key>` 2-arg contract matched (OBSERVED fleetctl:94). `box_ssh <box>
  <cmd-string>` usage matched (OBSERVED fleetctl:201; existing callers pass
  `"sudo $BOXUP_REMOTE status"`). `log`/`notify` style, exit codes (2=usage, 1=failure,
  distinct 4=absent) consistent with the surrounding enroll helpers. `mktemp`+`mv -f`
  atomic-replace mirrors existing seed patterns. No new binary, no new convention.
- Precedent-first: the awk-transform + cmp-no-op + atomic-rename is the established
  in-repo config-rewrite shape (mirrors boxup's own `_BOX_TOML_AWK` reader grammar);
  no novel hand-rolled machinery where a proven pattern exists. OK.

**(4) DESIGN.md "config.toml seeded once" invariant — PRESERVED with the D3 qualifier.**
OBSERVED DESIGN.md:171 now reads "…never overwritten (except `[fleet]`.vps/box_index/port,
written idempotently by `fleetctl enroll`)". Enroll writes ONLY those keys and
byte-preserves the rest (D3 two-pass awk + cmp no-op); the file is NEVER created (D9). The
invariant is NARROWED, not broken. Coherent.

## Checks for the EMPIRICAL gate (do NOT settle by reading)

- E1: does real `sshpass -e ssh … "sudo sh -s -- …"` (box_ssh, BatchMode=no, no `-T`)
  actually forward the `printf '%s' "$remote" |` STDIN to the remote `sh -s`? The fake
  recorder forwards stdin locally; real ssh stdin-forwarding to a non-tty remote is the
  live risk. Falsifier: remote `sh -s` reads empty stdin → no-op write, D10 verify fails.
- E2: run the +425-line test block under the real harness; confirm ALL currently-green
  tests in test-fleet-brain.sh + test-iter3-fixes.sh stay green (D5 regression claim).
- E3: the D10 read-back awk is deeply nested through `sudo sh -c "awk '…\\\"…\\\"…'"`;
  verify the escaping survives a real sh→sh→awk hop and returns the bare value.

## Rules artifacts
Zero-decision buildable: **YES**. PASS: 0 open BLOCKER, 0 MAJOR; 3 MINOR are doc/cosmetic
or explicitly routed to the empirical gate, none require a blueprint amendment.
Re-gate mode: FULL review of r3 (folds r1+r2), not delta-only, per dispatch.
