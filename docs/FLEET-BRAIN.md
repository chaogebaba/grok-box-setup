# FLEET-BRAIN.md — always-on VPS brain + out-of-band reverse-SSH channel

**Status: BLUEPRINT (design only — no code in this branch).** This is the
design wall for moving fleet reconciliation off the (not-always-online) laptop
onto a 24/7 VPS, reachable to every box over an out-of-band reverse-SSH tunnel,
with per-box tag-scoped Tailscale auth keys minted via the API. Same schema as
[docs/DESIGN.md](DESIGN.md): decision / alternatives considered + why they lost
/ breaks-if-undone / prior art. Open questions for the user are at the end.

## The problem this solves

The current fleet self-heals per box (`boxup` tick + hourly `boxup once`) but
has three gaps that need an off-box actor:

1. **Split-brain identity** (DESIGN.md wall, "On-box CANNOT self-heal an
   identity collision"): after an auth-key rejoin the OLD node lingers as an
   offline corpse holding the `grok-box-N` MagicDNS name. A box has no API
   creds by design (blast radius), so it cannot delete the corpse.
2. **The shared 90-day key + manual `.expires`** (H11): one shared key for the
   whole fleet, rotated by hand, with an operator-typed expiry sidecar. A dead
   key means no box can rejoin after state loss.
3. **The laptop is not always online.** `fleetctl` today runs from the laptop;
   reconciliation, rollout, and alerting stop when the laptop sleeps.

The chosen design: a **VPS brain** (`ssh -p 26333 root@199.180.115.53`,
full-root scope, footprint kept to one dir tree + one systemd unit set) that
reconciles the fleet on a timer, reaches each box over an **out-of-band
reverse-SSH tunnel** (independent of tailnet health), and mints **per-box
tag-scoped auth keys via the Tailscale API** (write-scoped token; laptop copy
at `~/.grok-box-apitoken`, never printed). Alerts go to Telegram via a
pluggable `notify()` stub (journal-only until the bot token exists).

---

## Decision wall

Schema: **Decision | Alternatives considered / why they lost | Breaks if undone | Prior art**.

### 1. On-box reverse tunnel

| Decision | Alternatives considered / why lost | Breaks if undone | Prior art |
|---|---|---|---|
| **The `boxup` tick supervises a plain `ssh -N` reverse tunnel in a loop** — NOT autossh, NOT a systemd unit. Each tick: if no live tunnel process for this box, (re)spawn `ssh -N -T -o exit-on-forward-failure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -R 127.0.0.1:$((20000+N)):localhost:22 -p 26333 fleet@199.180.115.53`, detached via `spawn_detached` (flock --close safe). Liveness = the ssh pid alive AND the forward is up (VPS side is authoritative — see §3). | (a) **autossh** — LOST on the BOX: autossh is a separate package not guaranteed present after an image swap (DESIGN.md: overlay wiped, only `/workspace` returns), and it is one more binary to vendor. Its whole job (respawn on death) is something the 15s tick ALREADY does for tailscaled/sshd/worker — one supervision model, not two. (b) **systemd unit on the box** — LOST: there is NO systemd running in the sand container (DESIGN.md §environment: PID 1 is tini, systemd on disk but inactive). A `.service` would never start. (c) **`ssh -f` (background itself)** — LOST: `-f` detaches from boxup's supervision so the tick can't track/replace it; use `-N` foreground under `spawn_detached` and let the tick own the lifecycle. | Boxes behind the sand NAT are unreachable when the tailnet is down — which is exactly when the brain most needs to reach them (to re-mint a key). No tunnel ⇒ the brain is blind precisely during the outage it exists to fix. | autossh-vs-systemd survey confirms both are viable ON A HOST but both assume a process supervisor exists: [systemd persistent tunnel](https://blog.kylemanna.com/linux/ssh-reverse-tunnel-on-linux-with-systemd/), [autossh systemd unit](https://gist.github.com/ntrepid8/0af12c012dd2567c800799d86eb44f90), [supervisord tunnel precedent (imbue-ai latchkey)](https://github.com/imbue-ai/mngr/issues/2423). We have no supervisor on the box except the boxup tick, so the tick IS the supervisor. `-o ExitOnForwardFailure=yes` + `ServerAlive*` from [ssh_config(5)] make a dead tunnel exit promptly so the next tick respawns it. |
| **Per-box ed25519 key at `/workspace/box-setup/secrets/tunnel_ed25519{,.pub}`** (mode 600, generated on the box, never leaves it as a private key). Survives image swaps because it lives under `/workspace`. | (a) reuse the tailscale node key / ssh host key — LOST: different trust domain; the tunnel key authenticates the box TO THE VPS, and rotating one must not disturb the others. (b) a shared fleet tunnel key — LOST: one leaked box key would grant every box's tunnel identity; per-box keys keep a box compromise to its own port (see §4). | Without a persistent per-box key the tunnel can't re-establish after a swap without re-enrollment every time. | [OpenSSH key management]; per-box-key isolation mirrors the per-box tailscale identity rule (DESIGN.md "Identity out of git"). |
| **Enrollment (chicken-and-egg): the box's tunnel PUBKEY first reaches the VPS over Tailscale SSH, via `fleetctl enroll <box>`** run from the brain (or laptop) WHILE the box is still on the tailnet. fleetctl reads the pubkey over `tailscale ssh grok-box-N cat /workspace/box-setup/secrets/tunnel_ed25519.pub` and appends a locked-down `authorized_keys` line (see §2) for `fleet@vps`. A box generates its keypair on first `boxup once` if absent. | (a) ship the pubkey in git / config.toml — LOST: per-box, generated on the box, must not be committed (same rule as identity). (b) have the box POST its own pubkey to the VPS — LOST: the box would need a VPS credential, widening blast radius; enrollment is a brain-initiated, one-time, tailnet-gated action. | No enrollment path ⇒ a fresh box's tunnel is never trusted by the VPS and the OOB channel never forms. | Tailscale SSH as the bootstrap channel: [Tailscale SSH docs](https://tailscale.com/kb/1193/tailscale-ssh). |
| **HONEST LIMIT: if `/workspace` itself is wiped, the tunnel key AND the frozen hostname are gone.** The box then has no tunnel identity and no name. Recovery REQUIRES a tailnet-side action (re-enrollment over Tailscale SSH, or a fresh auth-key join that the brain drives once the box reappears on the tailnet). The OOB tunnel is a second path for the *node-deleted-but-workspace-intact* case, NOT a workspace-loss backstop. | pretend the tunnel survives a workspace wipe — LOST: dishonest; `/workspace` is "probably persistent" (DESIGN.md) but not guaranteed, and the key/name live there. | Overstating the tunnel's coverage would hide the one failure it can't handle, inviting a false sense of recovery. | DESIGN.md §persistence-model ("keep a full re-join path for the day /workspace isn't"). |

### 2. VPS side (`fleet@`, `/opt/grok-fleet`, systemd)

| Decision | Alternatives considered / why lost | Breaks if undone | Prior art |
|---|---|---|---|
| **Footprint: one tree + one unit set.** Code+config at `/opt/grok-fleet` (fleetctl from THIS repo + `config.toml`), mutable state at `/var/lib/grok-fleet` (device cache, per-box last-seen, run locks), secrets mode 600 at `/etc/grok-fleet` (API token, and a COPY of each box's tunnel authorized-keys mapping). systemd `fleet-reconcile.timer` (OnUnitActiveSec=5min) → `fleet-reconcile.service` (Type=oneshot, runs `fleetctl reconcile`). | (a) cron — LOST: no per-run logging/lock/￼status the way a systemd oneshot + journal gives; the VPS HAS systemd (unlike the box), so use it. (b) a long-running daemon — LOST: a 5-min oneshot under a timer is crash-simple, has no in-memory state to corrupt, and each run re-reads truth from the API + tunnels. | Sprawl across the VPS makes the footprint unauditable and violates the "one dir + one unit set" scope the user granted. | systemd timer-vs-daemon for periodic reconcile: [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/systemd.timer.html); oneshot reconcile pattern mirrors DESIGN.md's D6 "one predicate, orchestrator trusts it". |
| **`fleet` user is shell-less and forward-only.** Each box's `~fleet/.ssh/authorized_keys` line is `restrict,port-forwarding,permitlisten="127.0.0.1:<20000+N>" <box pubkey>`. `restrict` disables pty/agent/X11/forwarding then `port-forwarding` re-enables ONLY forwarding; `permitlisten` pins the box to its OWN port and 127.0.0.1 only. `sshd_config` for that Match block: `PermitOpen none` (no local forwarding), `AllowTcpForwarding remote`, `PermitTTY no`, `ForceCommand /usr/sbin/nologin` (or `command="false"`). | (a) a real login user — LOST: a box compromise would get a VPS shell. (b) `no-pty,no-agent-forwarding,...` enumerated — LOST: `restrict` is allow-list-by-default (future-proof: new dangerous features are off unless re-enabled), the enumerated form is deny-list (a new feature defaults ON). (c) omit `permitlisten` — LOST: any box could then bind ANY loopback port and impersonate another box's tunnel. | Without `restrict`+`permitlisten` a single box key could open a shell or hijack another box's port on the brain — the brain becomes the fleet's single point of total compromise. | `restrict`/`permitlisten` semantics (allow-list, per-key port pin): [sshd(8) AUTHORIZED_KEYS](https://man.openbsd.org/OpenBSD-current/sshd) (note: `ssh -R` sends listen host "localhost" when unspecified, so pin `127.0.0.1:<port>` and have the box request `127.0.0.1:` explicitly); reverse-tunnel bastion hardening: [restrict on a bastion](https://blog.vitalvas.com/post/2026/02/04/reverse-ssh-tunnels/), [permitlisten Q&A](https://superuser.com/questions/1552105/). |
| **Deterministic port map: box N → VPS loopback port `20000+N`.** fleetctl derives it from `grok-box-N`; the same N is pinned in `permitlisten`. | a dynamic/negotiated port — LOST: then `permitlisten` can't be a fixed per-key pin and the brain can't address a box without a lookup handshake. | Non-deterministic ports break the per-key `permitlisten` pin (the security control) and make `fleetctl` unable to find a box's tunnel. | static allocation is the norm for named backends; mirrors DESIGN.md naming ("lowest free grok-box-N, then frozen"). |
| **The VPS ALSO joins the tailnet, tagged `tag:fleet-brain`, as a SECOND path — DECIDED: YES.** The tunnel is the out-of-band primary (works when the tailnet is down); the tailnet membership gives the brain (a) the enrollment channel (Tailscale SSH, §1), (b) a health cross-check (can the box reach the brain over BOTH paths?), and (c) a path to run `tailscale ssh` for first-contact before a tunnel exists. `tag:fleet-brain` gets NO exit-node/subnet rights in the ACL — it is a management identity only. | (a) tunnel-only, VPS off the tailnet — LOST: then enrollment has no bootstrap channel and the brain can't distinguish "tailnet down" from "this box down" (no second observation). (b) tailnet-only, no tunnel — LOST: the tailnet is exactly what fails in the case the brain exists to fix; the brain would be blind during the outage. | Tunnel-only loses the enrollment bootstrap and the two-path health signal; tailnet-only loses the brain during a tailnet outage. Both paths together are the design. | Two-path management (in-band + OOB) is standard for out-of-band mgmt; Tailscale tags as a management-only identity: [Tailscale ACL tags](https://tailscale.com/kb/1068/acl-tags). |

### 3. `fleetctl reconcile` — decision table

Runs every 5 min under the timer. **Inputs** per box: (i) the Tailscale API
device list (`GET /api/v2/tailnet/-/devices?fields=all` — `lastSeen`, `nodeId`,
`tags`, `keyExpiryDisabled`, `expires`, `hostname`); (ii) tunnel liveness (is
`127.0.0.1:20000+N` connectable on the VPS?); (iii) `boxup check` run OVER the
tunnel (`ssh -p 20000+N box@127.0.0.1 sudo /workspace/box-setup/boxup check`).

| # | Condition | Action | Notes / API |
|---|---|---|---|
| a | tailnet says the node is **gone/offline** (absent from devices, or `lastSeen` stale) BUT the **tunnel is alive** | mint a per-box tag-scoped key, seed it over the tunnel, run `boxup once` over the tunnel | `POST /api/v2/tailnet/-/keys` with `capabilities.devices.create = {reusable:false, ephemeral:false, preauthorized:true, tags:["tag:grok-box"]}`, `expirySeconds` ≤ 7776000. Write the returned `key` to `secrets/ts-authkey` over the tunnel (never logged) and the returned **`expires`** to `secrets/ts-authkey.expires` (replaces the manual H11 sidecar — see §6). Then `boxup once`. |
| b | **duplicate hostname** in the device list (≥2 devices whose `hostname`==grok-box-N) | delete the **OLDER OFFLINE** one | pick the device with the older `created`/`lastSeen` that is currently offline; `DELETE /api/v2/device/<id>`. NEVER delete the online one; if BOTH are online, do NOT delete — flag an incident (ambiguous, needs a human). |
| c | key **expiry < 7 days** (`expires` on the device, or our `secrets/ts-authkey.expires`) | **rotate**: mint a fresh per-box key (as in `a`), seed over the tunnel, update `.expires` | proactive; the per-box key + API `expires` supersede the manual 90-day sidecar. |
| d | **version drift** (`boxup check` / status `v=` != target sha) | **canary rollout REUSING the existing D7 rollout logic** (canary-first, verify via `boxup check`, abort-on-first-failure) — driven over the tunnels instead of laptop-over-tailnet | do NOT reimplement rollout; fleetctl already owns D7 canary/abort/no-auto-rollback. Deploy = push the new tree + `install.sh` (which runs the E1 version-change migration) over the tunnel. |
| e | **BOTH paths dead** (no tailnet device AND no tunnel) | **sleep vs incident — TIME-THRESHOLD, flagged OPEN for the user** | proposed: below a threshold T assume transient (box asleep / thawing) and do nothing; at/above T raise an incident via `notify()`. Default proposal **T = 30 min** (≥ the sand sleep/thaw window and > one hourly `once` period, so a genuinely-recoverable box has had a chance). **OPEN QUESTION #1** — user picks T and whether an incident is informational or actionable. |
| — | **idempotency + safety (applies to every row)** | a per-run `flock` on `/var/lib/grok-fleet/reconcile.lock` (never two reconciles at once); every action is idempotent (mint only if no valid key seeded this window; delete only a specific stale id; `boxup once` is already idempotent); and reconcile NEVER runs a box action while that box's OWN converge lock is held — it drives `boxup once`/`check` which take the box's lock themselves (D3), so the brain issues the command and lets the box serialize. The brain does not hold a box's lock; it calls boxup, which does. | mirrors DESIGN.md D3 (converge lock) + the D7 rollout flock. |

Key-mint capability shape and the `expires` return field are confirmed against
the API: [Tailscale API keys create — KeyCapabilities](https://api.tailscale.com/api/v2)
and [terraform-provider-tailscale tailnet_key](https://github.com/tailscale/terraform-provider-tailscale/blob/main/docs/resources/tailnet_key.md)
(defaults: `expiry` 7776000s = 90d, `reusable`/`ephemeral`/`preauthorized`
false). Device delete: [Remove a device via API](https://tailscale.com/docs/features/access-control/device-management/how-to/remove)
(`DELETE /api/v2/device/{id}`). Key expiry 1–90 days: [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys).

### 4. Trust / blast radius

| Actor compromised | What it exposes | Why bounded |
|---|---|---|
| **A single box** | ONLY that box's reverse-tunnel port on the VPS (`permitlisten="127.0.0.1:20000+N"`), and that box's own tailscale identity. It CANNOT get a VPS shell (`restrict`+`ForceCommand`), cannot bind another box's port, and holds NO API token. | Per-box tunnel key + `restrict`/`permitlisten` (§2); no API creds on any box (the whole reason the brain exists, DESIGN.md split-brain row). |
| **The VPS brain** | The write-scoped **Tailscale API token** (can mint keys + delete devices for the whole tailnet) AND every box's inbound tunnel (so it can `boxup once`/shell-via-box-sshd every box). This is the fleet's single most privileged host. | Accepted concentration: the token lives ONLY at `/etc/grok-fleet` (600) + the laptop copy `~/.grok-box-apitoken`, never printed, never in git; the API token is WRITE-scoped (device create/delete) but NOT admin (cannot change ACLs/billing). **OPEN QUESTION #2** — do we want the token scoped further (e.g. an OAuth client limited to `devices:core`+`auth_keys`) and short-lived+auto-refreshed rather than a long-lived PAT? |
| **The laptop** | Its copy of the API token. | Same token; if the laptop is the weaker host, prefer the VPS-only token + OAuth client (OQ #2). |

### 5. What moves OFF the box (subtraction) vs what MUST stay

**Moves off the box (now the brain's job):**
- Split-brain / duplicate-node reconciliation (needs the API — never on a box).
- Auth-key MINTING and rotation (per-box, API-driven) — replaces the shared
  90-day key and the operator-typed `.expires` file.
- Version-drift detection + canary rollout orchestration (already fleetctl's
  D7 job; now runs from the always-on brain, not the sometimes-on laptop).
- Fleet-wide alerting (`notify()` → Telegram).

**MUST stay on the box (non-negotiable):**
- **The hourly `boxup once` = the resurrection path.** It is the ONLY thing
  that re-converges a swapped box from `/workspace` alone with no external
  actor. The brain is an OPTIMIZER, not a replacement: a box must still fully
  self-heal (sleep/thaw, image swap, expired key with a valid seeded key) with
  the brain OFFLINE. (DESIGN.md "no systemd/cron on boxes → nothing schedules
  recovery" — the hourly external trigger is that scheduler.)
- **`boxup check`** — the single health predicate the brain reads over the
  tunnel; it stays the box's own definition of healthy (D6).
- The whole iter3 self-heal (flock --close lock, check_reason tick repair
  under backoff, recycle-then-read, H12/H13). The brain calls `boxup once`; the
  box does the converging.

Principle: the brain adds capabilities that STRUCTURALLY require an off-box
actor (API, cross-box view). It removes NOTHING that a lone box needs to
resurrect itself.

### 6. Migration from the shared-key fleet

Ordered, each step reversible:

1. **Stand up the brain read-only.** Deploy `/opt/grok-fleet` + timer, but
   `fleetctl reconcile --dry-run` only (log intended actions, mint/delete
   nothing). Verify the device list + tunnel liveness + `boxup check`-over-
   tunnel for all 8 boxes. **Rollback:** `systemctl disable --now
   fleet-reconcile.timer`; nothing was mutated.
2. **Enroll tunnels box-by-box** (`fleetctl enroll grok-box-N` over Tailscale
   SSH) while boxes are healthy on the tailnet. **Rollback:** remove the
   box's `authorized_keys` line on the VPS; the box's `ssh -N` loop just fails
   to connect (harmless, the tick keeps retrying).
3. **Per-box key cutover, one box first (canary).** For one box: mint a per-box
   key (row `a`), seed `secrets/ts-authkey` + `.expires` over the tunnel, run
   `boxup once`, confirm `boxup check` OK and the tailnet shows one healthy
   node. **Rollback:** the box still has the OLD shared key on disk until
   overwritten — keep a copy; restoring it reverts.
4. **Roll the per-box cutover to the rest** via the D7 canary path once the
   canary holds for a defined soak. **Rollback:** per-box, restore the shared
   key file + `.expires`.
5. **Retire the shared key** from the tailnet admin console only AFTER all 8
   boxes are on per-box keys and healthy for a soak window. **Rollback window
   closes here** — do not delete the shared key until the fleet is fully cut
   over.

**How H11 / `.expires` degrades gracefully:** H11 stays UNCHANGED in `boxup`.
Today an operator types `.expires`; after cutover the brain WRITES `.expires`
from the API key-create `expires` field (row `a`/`c`). If the brain is offline,
H11 still works exactly as today off whatever `.expires` is on disk (check
FAILs on expired, warns <7d, `none` when no key). A box with a per-box key and
a brain-written `.expires` is indistinguishable to `boxup` from one an operator
seeded — the per-box key FILE replaces the shared key, the brain-written date
replaces the hand-typed one, and nothing in `boxup`'s H11 logic changes. If the
brain never comes (worst case), the fleet runs exactly as it does today on the
last-seeded key until it expires.

---

## OPEN QUESTIONS for the user

1. **Row (e) threshold T** (both paths dead → sleep vs incident): confirm
   **T = 30 min** (proposed) or set another value, and say whether the incident
   at T is informational (log/Telegram note) or actionable (page).
2. **API credential shape** (§4): keep a long-lived write-scoped PAT at
   `~/.grok-box-apitoken` + `/etc/grok-fleet`, or move to an **OAuth client**
   (scopes `auth_keys` + `devices:core`) that fleetctl exchanges for a
   short-lived token per run (smaller blast radius, auto-refresh, no 90-day PAT
   rotation)? The OAuth path is more work but bounds a token leak to minutes.
3. **VPS tailnet tag** (§2): confirm `tag:fleet-brain` with NO exit-node/subnet
   rights, and that you'll add the `tagOwners`/ACL entry before I write code
   (same first-login ordering rule as `tag:grok-box`).
4. **Telegram**: confirm `notify()` stays a journal-only stub in this iteration
   (bot token + chat id land later), so nothing blocks on the bot existing.
5. **Port base** (§2): confirm `20000+N` (box-8 → 20008) is free on the VPS and
   doesn't collide with anything already listening on loopback there.
6. **Duplicate-both-online (row b)**: confirm the brain should NEVER auto-delete
   when both duplicates are online (flag a human) — i.e. we accept a rare
   manual step over a wrong auto-delete.
7. **Scope of `boxup once` over the tunnel**: the brain runs it as `sudo
   /workspace/box-setup/boxup once` via the box's own sshd (`box` user,
   passwordless sudo). Confirm the brain drives it through the box's sshd (not a
   second privileged channel), so the box's converge lock still serializes it.
