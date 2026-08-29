**Artifact-Path:** /home/chao/VScode_projects/grok-box-setup/tmp/orch/empirical-gate-enroll-one-step-r3.md
**Artifact-SHA256:** b625d5a20defdd8cef2b1e7b3626f0a6965f6b5153e6a4db8da32fe48f884f00
**Artifact-Repo-Path:** tmp/orch/empirical-gate-enroll-one-step-r3.md
**Git-SHA-root:** 58895efa59df9c9e67deea9b5738d3caafe4f620
**Git-SHA-base:** 89207af

# EMPIRICAL GATE + LIVE CANARY — feat/enroll-one-step r3

## VERDICT: PASS — 0 BLOCKER / 0 MAJOR / 1 MINOR

The frozen r3 diff passes its empirical gate. The authority file is byte-identical
to git diff 89207af..58895ef; both hash to
b625d5a20defdd8cef2b1e7b3626f0a6965f6b5153e6a4db8da32fe48f884f00.
Both suites are green (204 PASS / 0 FAIL total), lint and direct warning-level
shellcheck are clean, and all five decision-targeted mutants are killed by existing
tests. The live branch entry point ran on the VPS under env -i with the real
fleet-reconcile unit HOME/FLEET_CONFIG contract and scratch overrides for stateful
VPS outputs. On awake grok-box-2, it proved real SSH stdin delivery into sudo sh -s
(E1), the nested D10 shell/awk read-back (E3), D1 precheck refusal with zero side
effects, the config true no-op, state-b insertion as parsed by the installed boxup
reader, and D9 absent-config behavior. Exact pre-canary VPS and box state was restored;
the scratch directory and all box backups are absent.

### Findings

- **MINOR-1 — existing authorized_keys idempotency is semantic, not byte-level.**
  Re-enrolling grok-box-2 against a scratch copy of the live VPS authorized_keys
  kept seven lines and the exact normalized line set (sort hash before/after
  2743e3049fab236f3b63a5bb73826a9ad8ca85cfb7aab8f650058ab52b86d868)
  but moved the matching line to EOF, changing the raw hash 1071f9d2... to
  48c99806.... This is outside the r3 box-config decisions and changes no key,
  option, or access semantics, so it is non-gating. Smallest follow-up: make
  enroll_install_vps_authorized_key preserve an already-identical line/position
  (or cmp before mv) and add a raw-byte no-op regression test. The real
  /home/fleet/.ssh/authorized_keys was redirected away from and remained exact.

## STAGE 0 — frozen authority and tree

Commands and observations:

~~~text
sha256sum pinned diff
  b625d5a20defdd8cef2b1e7b3626f0a6965f6b5153e6a4db8da32fe48f884f00
git diff 89207af..58895ef > computed diff; sha256sum
  b625d5a20defdd8cef2b1e7b3626f0a6965f6b5153e6a4db8da32fe48f884f00
cmp
  DIFF_BYTE_IDENTICAL
git rev-parse HEAD
  58895efa59df9c9e67deea9b5738d3caafe4f620
~~~

The product worktree was clean at start and remained unedited. All mutation work used
an archive scratch copy, never the review tree.

## STAGE 1 — suite and lint

| Command | Observed result |
|---|---|
| bash tests/test-fleet-brain.sh | 145 PASS / 0 FAIL; ALL FLEET-BRAIN TESTS PASSED; rc 0 |
| bash tests/test-iter3-fixes.sh | 59 PASS / 0 FAIL; ALL TESTS PASSED; rc 0 |
| make lint | bash -n clean for five shell entry points; rc 0 |
| shellcheck -S warning fleetctl | no findings; rc 0 |

Total: **204 PASS / 0 FAIL**.

## STAGE 2 — mutation ledger

An archive of 58895ef was expanded under /tmp/enroll-mutants.xaWspD. Scratch baseline
was 145 PASS / 0 FAIL. Clean fleetctl sha:
8fcf1dc13f9b58b0bada5663bf0b5e8f08a3341e07568962e71e571208e70069.
For every mutant: apply only to scratch, run the existing fleet-brain suite, capture
failures, restore fleetctl.clean, and verify the clean sha.

| Mutant | Decision falsified | Result | Killing test(s) / counts |
|---|---|---|---|
| M1: baked VPS fallback restored | D1 env/config-only, else refuse | KILLED | unresolved-refuse + zero-side-effect precheck; 143 P / 2 F |
| M2: enrollment recorded before config write | D8 no record after write/exit-4 failure | KILLED | D8 generic failure + D8/D9 exit-4; 143 P / 2 F |
| M3: non-default port always suppressed | D3b retain non-default port | KILLED | fresh, replace, and append port 2222; 142 P / 3 F |
| M4: return before D10 read-back | D10 verify each written key | KILLED | mismatch expected rc 1, got rc 0; 144 P / 1 F |
| M5: omit [fleet] in no-header append | D3c never append bare keys | KILLED | no-block append returned rc 1; 144 P / 1 F |

All **5/5** mutants were killed. Every restore was sha-verified and the final scratch
sha equals the baseline sha.

## STAGE 3 — LIVE CANARY

### Containment and systemd entry-point environment

Target: root@107.172.132.211. Selected box: grok-box-2, Online=True. grok-box-7 was
confirmed offline and was not touched.

Branch temp binary:
~~~text
/root/tmp-canary/fleetctl
sha=8fcf1dc13f9b58b0bada5663bf0b5e8f08a3341e07568962e71e571208e70069
mode=700 root:root
~~~

Real unit environment:
~~~text
HOME=/var/lib/grok-fleet
FLEET_CONFIG=/opt/grok-fleet/config.toml
FLEET_ETC=/etc/grok-fleet
FLEET_STATE=/var/lib/grok-fleet
~~~

Each branch call used env -i, real HOME and FLEET_CONFIG. To obey the scope wall and
leave real VPS state read-only, stateful outputs were redirected to
/root/tmp-canary/{etc,state,vps-ak}: FLEET_ETC, FLEET_STATE,
FLEET_VPS_AUTHKEYS, and a copied public FLEET_BOX_KEY.pub. The real config remained
the in-use config for API/SSH settings. Its active [fleet-brain].vps count was 0.

Before snapshots:
~~~text
real VPS authorized_keys:
 sha=1071f9d24bddd9d74d4165c89eb84d75be9fc77df15f6284130ea2a65b5eb29b
 mode=600 owner=fleet:fleet size=1120 mtime=1787964465 inode=3857
real enrolled.tsv:
 sha=de134f1f3aaea33847df82e32fa9524b343c9938d4c7f79789b016f0a229af12
 mode=644 owner=root:root size=119 mtime=1787973847 inode=395069
box config.toml:
 sha=b9c3a1447cdd2f4aa3df63654cc1ba48db68d9470007342141426baf14bcfb8e
 mode=600 owner=root:root size=1272 mtime=1787964385 inode=1711467
box authorized_keys:
 sha=175c43b3553d3ce64aec3d83263f273013ae8cf2b3459ad51a096f745579e020
 mode=600 owner=box:box size=186 mtime=1787964188 inode=1718511
~~~

### (i) D1 unresolved address

FLEET_VPS_ADDR was omitted and the in-use brain config had no active
[fleet-brain].vps.

~~~text
enroll: REFUSING — no VPS address resolved for the box-side [fleet].vps.
enroll: set FLEET_VPS_ADDR in the env, or add vps = "<addr>" under [fleet-brain] ...
case_i_rc=1
~~~

All exact comparisons passed: real and scratch VPS authorized_keys, real and scratch
enrolled.tsv, box config, and box authorized_keys retained sha/stat/inode. D1 returned
non-zero with a clear message and zero side effects.

### (ii) Already-enrolled no-op

The call added FLEET_VPS_ADDR=107.172.132.211.

~~~text
case_ii_rc=0
config before: sha=b9c3a144... mode=600 size=1272 mtime=1787964385 inode=1711467
config after:  sha=b9c3a144... mode=600 size=1272 mtime=1787964385 inode=1711467
scratch enrolled rows for grok-box-2=1
real enrolled rows for grok-box-2=1
~~~

The box config was a true no-op including sha, mode, size, mtime, and inode. D10
succeeded and logged "and verified it". Scratch enrolled.tsv retained exactly one row;
real enrolled.tsv was exact. Box authorized_keys content was unchanged. Real VPS
authorized_keys was exact; the scratch probe showed only MINOR-1's same-set line
permutation.

### (iii) State b, E1, E3, and the installed boxup reader

The original config inode was retained via a hard-link backup. Active vps and box_index
were converted to comments:

~~~text
35:# vps = "107.172.132.211"
36:# box_index = 2
active vps/box_index count=0
~~~

Branch enroll returned 0. After the write:

~~~text
35:# vps = "107.172.132.211"
36:vps = "107.172.132.211"
37:# box_index = 2
38:box_index = 2
mode=600
~~~

This could only land if real sshpass/ssh in box_ssh forwarded the branch function's
stdin into remote sudo sh -s: **E1 PASS**. The same invocation emitted the verified
log after its nested sh to sh to awk reads: **E3/D10 PASS**.

A probe sourced the installed live boxup only up to dispatch and invoked its exact
config_get implementation:

~~~text
vps=107.172.132.211 box_index=2 port=22
~~~

The installed sudo /workspace/box-setup/boxup status path returned:

~~~text
... name=grok-box-2 v=5.2.0/0c34fba tunnel=up
~~~

The original config pathname was restored and matched the entire initial snapshot.

### (iv) D9 absent config

The original config was moved aside. Enroll returned non-zero:

~~~text
enroll: WARNING box config not written — ... config.toml is ABSENT ...; run install.sh on the box first
... NOT recording enrollment ...
case_iv_rc=1
~~~

The branch did not recreate config.toml. Scratch enrolled.tsv was exact before/after
including sha, mode, mtime, and inode. Real enrolled.tsv remained exact. Moving the
original config back restored its complete initial snapshot.

### Final restoration and cleanup

The pre-existing box key installer touches the box authorized_keys before replacing
it, which advanced the hard-link backup mtime. Cleanup reapplied the recorded original
epoch after moving the original inode back. Final independent probe:

~~~text
box config:
 sha=b9c3a1447cdd2f4aa3df63654cc1ba48db68d9470007342141426baf14bcfb8e
 mode=600 owner=root:root size=1272 mtime=1787964385 inode=1711467
box authorized_keys:
 sha=175c43b3553d3ce64aec3d83263f273013ae8cf2b3459ad51a096f745579e020
 mode=600 owner=box:box size=186 mtime=1787964188 inode=1718511
real VPS authorized_keys:
 sha=1071f9d24bddd9d74d4165c89eb84d75be9fc77df15f6284130ea2a65b5eb29b
 mode=600 owner=fleet:fleet size=1120 mtime=1787964465 inode=3857
real enrolled.tsv:
 sha=de134f1f3aaea33847df82e32fa9524b343c9938d4c7f79789b016f0a229af12
 mode=644 owner=root:root size=119 mtime=1787973847 inode=395069
~~~

No box backup remains. /root/tmp-canary is absent. The deployed
/opt/grok-fleet/fleetctl, systemd units, real fleet state, and unrelated VPS
services/files were never modified.

## Summary

- Frozen authority: VALID and byte-identical to the computed commit diff.
- E1 real SSH stdin forwarding: PASS.
- E2 full suite: PASS, 204/0.
- E3 real nested D10 read-back quoting: PASS.
- Mutation strength: 5/5 KILLED.
- Live D1/D3/D8/D9/D10: PASS.
- Restoration: exact sha/mode/owner/size/mtime/inode restored; scratch gone.
- Final verdict: **PASS — 0 BLOCKER / 0 MAJOR / 1 MINOR**.
