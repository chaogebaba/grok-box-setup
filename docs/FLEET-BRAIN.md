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

The chosen design: a **VPS brain** (`ssh root@107.172.132.211`, port 22, key
auth, full-root scope, footprint kept to one dir tree + one systemd unit set)
that reconciles the fleet on a timer, reaches each box over an **out-of-band
reverse-SSH tunnel** (independent of tailnet health), and mints **per-box
tag-scoped auth keys via the Tailscale API** (write-scoped token; laptop copy at
`~/.grok-box-apitoken`, never printed). Alerts go to Telegram via a pluggable
`notify()` stub (journal-only until the bot token exists).

---

## VPS ground truth (inventoried read-only 2026-08-28 — do not re-probe blindly)

Design against THESE facts, not assumptions:

- **Reach:** `ssh root@107.172.132.211` (port **22**, key auth works). The
  earlier `199.180.115.53:26333` address is **DEAD — never use it.**
- **Host:** Ubuntu 24.04.4, kernel 6.8, uptime ~6d.
- **Budget (TIGHT):** **1 vCPU, ~961 MB RAM (~590 MB available), 30 GB disk
  (21 GB free).** ⇒ brain is **bash + curl + jq + ssh only** — NO extra
  daemons beyond sshd (the inbound tunnels) + one systemd timer. Budget the
  reverse tunnels: ~a few MB RSS per idle `sshd: fleet` session × 8 boxes =
  low tens of MB, acceptable; do NOT add anything memory-hungry (no node/python
  service, no DB).
- **Tailscale:** 1.102.3 installed, `tailscaled.service` running but
  `BackendState=NeedsLogin` (0 peers — NOT in any tailnet). ⇒ "VPS joins the
  tailnet" (§2) is a ONE-TIME `tailscale up` with a **tagged** key
  (`tag:fleet-brain`; needs the ACL `tagOwners` entry first — see Resolved
  decision 3, and `fleetctl enroll` prechecks it via `GET /acl`).
- **Do NOT disturb these running services:** xray (ports 1001/1002/1006/1080/
  1234), hysteria (443), WireGuard `wg0` 10.66.0.1/24, cron,
  unattended-upgrades, rsyslog. Our reverse ports (20001–20008) and anything we
  add must not collide with these.
- **sshd:** port 22, `PermitRootLogin yes`, `PasswordAuthentication yes`,
  `AllowTcpForwarding yes`, **`GatewayPorts no`** (GOOD — reverse forwards bind
  `127.0.0.1` only, exactly the design), **`ClientAliveInterval 0`** (so the
  VPS will NOT reap dead tunnels — **liveness MUST be client-driven**:
  `ServerAliveInterval`/`ServerAliveCountMax` from the box, plus a VPS-side
  `ss -tln` probe on `127.0.0.1:2000N` in reconcile). No fail2ban. No existing
  `/opt/*` and no systemd timers — `/opt/grok-fleet` + our timer are greenfield.

## Decision wall

Schema: **Decision | Alternatives considered / why they lost | Breaks if undone | Prior art**.

### 1. On-box reverse tunnel

| Decision | Alternatives considered / why lost | Breaks if undone | Prior art |
|---|---|---|---|
| **The `boxup` tick supervises a plain `ssh -N` reverse tunnel in a loop** — NOT autossh, NOT a systemd unit. Each tick: if no live tunnel process for this box, (re)spawn `ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o BatchMode=yes -i /workspace/box-setup/secrets/tunnel_ed25519 -R 127.0.0.1:$((20000+N)):localhost:22 -p 22 fleet@107.172.132.211`, detached via `spawn_detached` (flock --close safe). Liveness is **client-driven** — the VPS has `ClientAliveInterval 0` and will NOT reap a dead tunnel, so `ServerAliveInterval/CountMax` on the box side must drop a stale link (and the VPS reconcile cross-checks with `ss -tln`). Box-side liveness = the ssh pid alive AND (VPS-side) the port is listening. | (a) **autossh** — LOST on the BOX: autossh is a separate package not guaranteed present after an image swap (DESIGN.md: overlay wiped, only `/workspace` returns), and it is one more binary to vendor. Its whole job (respawn on death) is something the 15s tick ALREADY does for tailscaled/sshd/worker — one supervision model, not two. (b) **systemd unit on the box** — LOST: there is NO systemd running in the sand container (DESIGN.md §environment: PID 1 is tini, systemd on disk but inactive). A `.service` would never start. (c) **`ssh -f` (background itself)** — LOST: `-f` detaches from boxup's supervision so the tick can't track/replace it; use `-N` foreground under `spawn_detached` and let the tick own the lifecycle. | Boxes behind the sand NAT are unreachable when the tailnet is down — which is exactly when the brain most needs to reach them (to re-mint a key). No tunnel ⇒ the brain is blind precisely during the outage it exists to fix. | autossh-vs-systemd survey confirms both are viable ON A HOST but both assume a process supervisor exists: [systemd persistent tunnel](https://blog.kylemanna.com/linux/ssh-reverse-tunnel-on-linux-with-systemd/), [autossh systemd unit](https://gist.github.com/ntrepid8/0af12c012dd2567c800799d86eb44f90), [supervisord tunnel precedent (imbue-ai latchkey)](https://github.com/imbue-ai/mngr/issues/2423). We have no supervisor on the box except the boxup tick, so the tick IS the supervisor. `ExitOnForwardFailure=yes` + `ServerAlive*` from [ssh_config(5)] make a dead tunnel exit promptly so the next tick respawns it — mandatory here because the VPS's `ClientAliveInterval 0` won't. |
| **Per-box ed25519 key at `/workspace/box-setup/secrets/tunnel_ed25519{,.pub}`** (mode 600, generated on the box, never leaves it as a private key). Survives image swaps because it lives under `/workspace`. | (a) reuse the tailscale node key / ssh host key — LOST: different trust domain; the tunnel key authenticates the box TO THE VPS, and rotating one must not disturb the others. (b) a shared fleet tunnel key — LOST: one leaked box key would grant every box's tunnel identity; per-box keys keep a box compromise to its own port (see §4). | Without a persistent per-box key the tunnel can't re-establish after a swap without re-enrollment every time. | [OpenSSH key management]; per-box-key isolation mirrors the per-box tailscale identity rule (DESIGN.md "Identity out of git"). |
| **Enrollment (chicken-and-egg): the box's tunnel PUBKEY first reaches the VPS over OpenSSH on the tailnet, via `fleetctl enroll <box>`** run from the brain (or laptop) WHILE the box is still on the tailnet. fleetctl reads the pubkey over `ssh box@grok-box-N sudo cat /workspace/box-setup/secrets/tunnel_ed25519.pub` (the box's own OpenSSH server on the tailnet, reached with the laptop/VPS operator key or password) and appends a locked-down `authorized_keys` line (see §2) for `fleet@vps`. **This is the SAME OpenSSH-over-tailnet channel the reconciler uses for box access (Resolved decision 7)** — one login model, not two. **Tailscale SSH is NOT usable here:** the frozen on-box wall runs every box with `--ssh=false` ("Tailscale SSH stays off: OpenSSH is the only login path", DESIGN.md), so `tailscale ssh grok-box-N` cannot connect — the TS-SSH server is off on the destination. A box generates its keypair on first `boxup once` if absent. **Precondition check (Q3):** enroll first does `GET /api/v2/tailnet/-/acl` and REFUSES with a clear message if `tag:fleet-brain` has no `tagOwners` entry — a box rebuilding identity with an unauthorized tag can't rejoin, so the ACL must exist before any tagged join. | (a) ship the pubkey in git / config.toml — LOST: per-box, generated on the box, must not be committed (same rule as identity). (b) have the box POST its own pubkey to the VPS — LOST: the box would need a VPS credential, widening blast radius; enrollment is a brain-initiated, one-time, tailnet-gated action. (c) skip the ACL precheck — LOST: a missing `tagOwners` entry fails the tagged join opaquely; check it up front. (d) **Tailscale SSH as the bootstrap channel — LOST: disabled fleet-wide by the on-box wall (`--ssh=false`); OpenSSH is the only login path to a box, so enrollment and first-contact MUST use OpenSSH over the tailnet.** | No enrollment path ⇒ a fresh box's tunnel is never trusted by the VPS and the OOB channel never forms; no ACL precheck ⇒ a tagged join fails cryptically. | OpenSSH over the tailnet is the box's only login path (DESIGN.md `--ssh=false` wall); ACL read: [Tailscale API GET /acl](https://tailscale.com/api#tag/policyfile). |
| **HONEST LIMIT: if `/workspace` itself is wiped, the tunnel key AND the frozen hostname are gone.** The box then has no tunnel identity and no name. Recovery REQUIRES a tailnet-side action (re-enrollment over OpenSSH on the tailnet, or a fresh auth-key join that the brain drives once the box reappears on the tailnet). The OOB tunnel is a second path for the *node-deleted-but-workspace-intact* case, NOT a workspace-loss backstop. | pretend the tunnel survives a workspace wipe — LOST: dishonest; `/workspace` is "probably persistent" (DESIGN.md) but not guaranteed, and the key/name live there. | Overstating the tunnel's coverage would hide the one failure it can't handle, inviting a false sense of recovery. | DESIGN.md §persistence-model ("keep a full re-join path for the day /workspace isn't"). |

### 2. VPS side (`fleet@`, `/opt/grok-fleet`, systemd)

| Decision | Alternatives considered / why lost | Breaks if undone | Prior art |
|---|---|---|---|
| **Footprint: one tree + one unit set.** Code+config at `/opt/grok-fleet` (fleetctl from THIS repo + `config.toml`), mutable state at `/var/lib/grok-fleet` (device cache, per-box last-seen, run locks), secrets mode 600 at `/etc/grok-fleet` (API token, and a COPY of each box's tunnel authorized-keys mapping). systemd `fleet-reconcile.timer` (OnUnitActiveSec=5min) → `fleet-reconcile.service` (Type=oneshot, runs `fleetctl reconcile`). | (a) cron — LOST: no per-run logging/lock/￼status the way a systemd oneshot + journal gives; the VPS HAS systemd (unlike the box), so use it. (b) a long-running daemon — LOST: a 5-min oneshot under a timer is crash-simple, has no in-memory state to corrupt, and each run re-reads truth from the API + tunnels. | Sprawl across the VPS makes the footprint unauditable and violates the "one dir + one unit set" scope the user granted. | systemd timer-vs-daemon for periodic reconcile: [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/systemd.timer.html); oneshot reconcile pattern mirrors DESIGN.md's D6 "one predicate, orchestrator trusts it". |
| **`fleet` user is shell-less and forward-only.** Each box's `~fleet/.ssh/authorized_keys` line is `restrict,port-forwarding,permitlisten="127.0.0.1:<20000+N>" <box pubkey>`. `restrict` disables pty/agent/X11/forwarding then `port-forwarding` re-enables ONLY forwarding; `permitlisten` pins the box to its OWN port and 127.0.0.1 only. `sshd_config` for that Match block: `PermitOpen none` (no local forwarding), `AllowTcpForwarding remote`, `PermitTTY no`, `ForceCommand /usr/sbin/nologin` (or `command="false"`). | (a) a real login user — LOST: a box compromise would get a VPS shell. (b) `no-pty,no-agent-forwarding,...` enumerated — LOST: `restrict` is allow-list-by-default (future-proof: new dangerous features are off unless re-enabled), the enumerated form is deny-list (a new feature defaults ON). (c) omit `permitlisten` — LOST: any box could then bind ANY loopback port and impersonate another box's tunnel. | Without `restrict`+`permitlisten` a single box key could open a shell or hijack another box's port on the brain — the brain becomes the fleet's single point of total compromise. | `restrict`/`permitlisten` semantics (allow-list, per-key port pin): [sshd(8) AUTHORIZED_KEYS](https://man.openbsd.org/OpenBSD-current/sshd) (note: `ssh -R` sends listen host "localhost" when unspecified, so pin `127.0.0.1:<port>` and have the box request `127.0.0.1:` explicitly); reverse-tunnel bastion hardening: [restrict on a bastion](https://blog.vitalvas.com/post/2026/02/04/reverse-ssh-tunnels/), [permitlisten Q&A](https://superuser.com/questions/1552105/). |
| **Deterministic port map: box N → VPS loopback port `20000+N` (range 20001–20008 for boxes 1–8).** fleetctl derives it from `grok-box-N`; the same N is pinned in `permitlisten`. This range is confirmed clear of the VPS's existing listeners (xray 1001/1002/1006/1080/1234, hysteria 443, wg0) — see VPS ground truth. | a dynamic/negotiated port — LOST: then `permitlisten` can't be a fixed per-key pin and the brain can't address a box without a lookup handshake. | Non-deterministic ports break the per-key `permitlisten` pin (the security control) and make `fleetctl` unable to find a box's tunnel; a colliding port would clash with xray/hysteria. | static allocation is the norm for named backends; mirrors DESIGN.md naming ("lowest free grok-box-N, then frozen"). |
| **The VPS ALSO joins the tailnet, tagged `tag:fleet-brain`, as a SECOND path — DECIDED: YES.** The tunnel is the out-of-band primary (works when the tailnet is down); the tailnet membership gives the brain (a) the enrollment channel (**OpenSSH over the tailnet** — `ssh box@grok-box-N …`; Tailscale SSH is off fleet-wide, §1), (b) a health cross-check (can the box reach the brain over BOTH paths?), and (c) a path to reach a box over OpenSSH for first-contact before a tunnel exists. `tag:fleet-brain` gets NO exit-node/subnet rights in the ACL — it is a management identity only. Joining is a ONE-TIME `tailscale up --advertise-tags=tag:fleet-brain` (the VPS's tailscaled is installed + running but `NeedsLogin` — VPS ground truth). | (a) tunnel-only, VPS off the tailnet — LOST: then enrollment has no bootstrap channel and the brain can't distinguish "tailnet down" from "this box down" (no second observation). (b) tailnet-only, no tunnel — LOST: the tailnet is exactly what fails in the case the brain exists to fix; the brain would be blind during the outage. | Tunnel-only loses the enrollment bootstrap and the two-path health signal; tailnet-only loses the brain during a tailnet outage. Both paths together are the design. | Two-path management (in-band + OOB) is standard for out-of-band mgmt; Tailscale tags as a management-only identity: [Tailscale ACL tags](https://tailscale.com/kb/1068/acl-tags). |
| **We do NOT touch the VPS's global sshd config this iteration; the `fleet` user is key-only via its OWN `authorized_keys`.** VPS ground truth: `PasswordAuthentication yes`, `PermitRootLogin yes` globally — accepted AS-IS (changing them risks locking out the operator / disturbing xray/hysteria/wg0 coexisting on the host). The `fleet` user carries no password (`passwd -l fleet`) so `PasswordAuthentication yes` cannot be used against it; its only credential is the per-box pubkey lines with `restrict,...,permitlisten`. | (a) harden global sshd (set PasswordAuthentication no, PermitRootLogin prohibit-password) — LOST this iteration: out of scope, high blast radius on a shared host we don't own the policy of; it's the operator's call, tracked as a follow-up. | If we silently rewrote global sshd we could lock out root or break the operator's other access; keeping `fleet` locked + key-only bounds our change to one user. | Per-user `authorized_keys` restriction without global changes: [sshd(8) AUTHORIZED_KEYS](https://man.openbsd.org/OpenBSD-current/sshd). |
| **Tunnels MUST survive an sshd restart (unattended-upgrades).** VPS ground truth: `unattended-upgrades` is active and may restart `sshd`, dropping every reverse tunnel. The box-side `ssh -N` carries `ServerAliveInterval=30 ServerAliveCountMax=3` so a dropped tunnel dies within ~90s and the next boxup tick respawns it; the VPS-side `ss -tln` probe (reconcile input ii) confirms re-listen. No VPS-side keepalive is possible (`ClientAliveInterval 0`, and we don't touch global sshd). | rely on the VPS to keep the tunnel — LOST: `ClientAliveInterval 0` means the VPS never reaps/notices a half-dead tunnel; recovery MUST be client-driven. | Without client-side ServerAlive + tick respawn, an sshd restart silently blinds the brain to every box until the next full reconnect. | ssh keepalive semantics: [ssh_config(5) ServerAliveInterval]. |

### 3. `fleetctl reconcile` — decision table

Runs every 5 min under the timer. **Inputs** per box: (i) the Tailscale API
device list (`GET /api/v2/tailnet/-/devices?fields=all` — `lastSeen`, `nodeId`,
`tags`, `keyExpiryDisabled`, `expires`, `hostname`); (ii) tunnel liveness — a
VPS-side `ss -tln` check that `127.0.0.1:2000N` is LISTENING (the VPS has
`ClientAliveInterval 0`, so a listening port is the authoritative "tunnel up"
signal, cross-checked by whether a `boxup check` over it succeeds); (iii)
`boxup check` run OVER the tunnel (`ssh -p 2000N box@127.0.0.1 sudo
/workspace/box-setup/boxup check`).

| # | Condition | Action | Notes / API |
|---|---|---|---|
| a | tailnet says the node is **gone/offline** (absent from devices, or `lastSeen` stale) BUT the **tunnel is alive** | mint a per-box tag-scoped key, seed it ATOMICALLY over the tunnel, run `boxup once` over the tunnel | `POST /api/v2/tailnet/-/keys` with `capabilities.devices.create = {reusable:true, ephemeral:false, preauthorized:true, tags:["tag:grok-box"]}`, `expirySeconds` ≤ 7776000 (90d). **`reusable:true, ephemeral:false` is MANDATORY** (frozen on-box wall, H11): the seeded key must survive REPEATED state-loss rejoins between rotations — a `reusable:false` key dies on first consumption, killing the box's unattended-rejoin path for the next state-loss event. Per-box scoping + rotation (row c) + API revoke on rotation is the blast-radius control, NOT single-use. **Atomic + verified seed (S1):** write the returned `key` to `secrets/.ts-authkey.tmp` (mode 600) over the tunnel, `sha256sum` verify the write, `mv` into place `secrets/ts-authkey`; then write the returned **`expires`** to `secrets/ts-authkey.expires` (replaces the manual H11 sidecar — see §6). Confirm via `sudo boxup status` over the tunnel that the new authkey state shows BEFORE the brain records the mint as done / advances the mint-window guard; on verify-fail, do NOT advance the guard (retry next tick). Never log the key. |
| b | **duplicate hostname** in the device list (≥2 devices whose `hostname`==grok-box-N) | delete the **OLDER OFFLINE** one, THEN restore the live node's name | pick the device with the older `created`/`lastSeen` that is currently offline; `DELETE /api/v2/device/<stale-id>`. THEN — because a state-loss rejoin gives the LIVE node the MagicDNS name `grok-box-N-1` and `tailscale set --hostname` does NOT clear the `-1` suffix (F2, verified on box-8) — restore the name via `POST /api/v2/device/<live-id>/name` `{"name":"grok-box-N"}` (verified HTTP 200, name restored). NEVER delete the online one; if BOTH are online, do NOT delete — flag an incident (ambiguous, needs a human). **Eventual consistency (P2-4):** rows `a` and `b` are eventually consistent ACROSS reconcile runs, not atomic — the mint in `a` creates the `grok-box-N-1` corpse that `b` renames on a LATER run, so `grok-box-N` may resolve to the corpse for up to one 5-min window post-rejoin. |
| c | **AUTH-KEY expiry < 7 days** (the minted key's `expires`, persisted to `secrets/ts-authkey.expires`) | **rotate**: mint a fresh per-box key (same shape as `a` — `reusable:true, ephemeral:false, preauthorized:true`), seed ATOMICALLY over the tunnel (S1), update `.expires`, then API-revoke the OLD key | Proactive. **Two DIFFERENT clocks — do not conflate (S2):** (i) the **AUTH-KEY expiry** = the `expires` RETURNED by the key-create in row `a`, persisted to `.expires` — THIS is our rotation trigger (< 7d). (ii) the device **NODE-KEY expiry** = `expires` on the *device* object, governed by `keyExpiryDisabled=true` fleet-wide — NOT our concern and NOT a rotation trigger. Rotate on (i) only; never read the device node-key `expires` as if it were the auth-key expiry. The per-box key + API `expires` supersede the manual 90-day sidecar. |
| d | **version drift** (`boxup check` / status `v=` != target sha) | **canary rollout REUSING the existing D7 rollout logic** (canary-first, verify via `boxup check`, abort-on-first-failure) — driven over the tunnels instead of laptop-over-tailnet | do NOT reimplement rollout; fleetctl already owns D7 canary/abort/no-auto-rollback. Deploy = push the new tree + `install.sh` (which runs the E1 version-change migration) over the tunnel. |
| e | **BOTH paths dead** (no tailnet device/stale `lastSeen` AND no tunnel) | tiered per Q1 (user ruling) | **Informational "asleep"** after **T = 2h** of both-paths-dead (≈ two missed hourly `once` windows): one alert, then a DAILY digest — a sand box legitimately sleeps. **ACTIONABLE incident** (paged, not digest) IMMEDIATELY — after 2 consecutive reconcile runs — when the split is INCOHERENT: the API says the device is **online / `lastSeen` fresh** yet BOTH paths are dead (something is lying), OR tunnel-alive + `boxup check` FAIL persists **> 3 runs** (a box that is reachable but cannot converge). |
| — | **API failure / rate-limit policy (S3, applies to every row)** | on any Tailscale API **non-2xx (429 / 5xx / timeout)**, the run is **READ-ONLY**: no mint, no delete, no rename this run. Retry on the next timer tick with bounded backoff **5 → 10 → 20 min**; `notify()` alert after **3 consecutive** API failures. NEVER act on a **partial device list** (a truncated/errored `GET devices` is treated as no data, not as "device absent" → never triggers a delete or a mint). | fail-closed + idempotent: a failing dependency must not half-complete a mutation (esp. combined with the atomic-seed guard in row `a`). |
| — | **idempotency + safety (applies to every row)** | a per-run `flock` on `/var/lib/grok-fleet/reconcile.lock` (never two reconciles at once); every action is idempotent (mint only if no valid key seeded this window; delete only a specific stale id; `boxup once` is already idempotent); and reconcile NEVER runs a box action while that box's OWN converge lock is held — it drives `boxup once`/`check` which take the box's lock themselves (D3), so the brain issues the command and lets the box serialize. The brain does not hold a box's lock; it calls boxup, which does. | mirrors DESIGN.md D3 (converge lock) + the D7 rollout flock. |

Key-mint capability shape and the `expires` return field are confirmed against
the API: [Tailscale API keys create — KeyCapabilities](https://api.tailscale.com/api/v2)
and [terraform-provider-tailscale tailnet_key](https://github.com/tailscale/terraform-provider-tailscale/blob/main/docs/resources/tailnet_key.md)
(defaults: `expiry` 7776000s = 90d, `reusable`/`ephemeral`/`preauthorized`
false — we EXPLICITLY override `reusable:true, ephemeral:false, preauthorized:true`,
row `a`/`c`, per the frozen H11 wall). Device delete: [Remove a device via API](https://tailscale.com/docs/features/access-control/device-management/how-to/remove)
(`DELETE /api/v2/device/{id}`). Key expiry 1–90 days: [Auth keys](https://tailscale.com/docs/features/access-control/auth-keys).

### 4. Trust / blast radius

| Actor compromised | What it exposes | Why bounded |
|---|---|---|
| **A single box** | ONLY that box's reverse-tunnel port on the VPS (`permitlisten="127.0.0.1:20000+N"`), and that box's own tailscale identity. It CANNOT get a VPS shell (`restrict`+`ForceCommand`), cannot bind another box's port, and holds NO API token. | Per-box tunnel key + `restrict`/`permitlisten` (§2); no API creds on any box (the whole reason the brain exists, DESIGN.md split-brain row). |
| **The VPS brain** | The write-scoped **Tailscale API token** (can mint keys + delete devices for the whole tailnet) AND every box's inbound tunnel (so it can `boxup once`/shell-via-box-sshd every box). This is the fleet's single most privileged host. | Accepted concentration: the token lives ONLY at `/etc/grok-fleet` (600) + the laptop copy `~/.grok-box-apitoken`, never printed, never in git; the API token is WRITE-scoped (device create/delete) but NOT admin (cannot change ACLs/billing). Credential-shape decision below (Q2). |
| **The laptop** | Its copy of the API token. | Same token; the OAuth follow-up (below) would bound a laptop-copy leak to minutes. |

**Credential shape (Q2, DECIDED):**

| Decision | Alternatives considered / why lost | Breaks if undone | Prior art |
|---|---|---|---|
| **Use the existing long-lived write-scoped PAT this iteration** (`~/.grok-box-apitoken` + `/etc/grok-fleet`, mode 600, never printed, never in git). | **OAuth client → short-lived per-run token** — LOST *this iteration* (it is the FOLLOW-UP): it's the smaller blast radius (a leak expires in minutes, no 90-day PAT rotation) but it's an extra moving part (client-id/secret storage, a token-exchange step in every reconcile, failure mode if the exchange 500s), and the PAT is already minted and working. Ship the PAT now; migrate to an OAuth client (`scopes auth_keys + devices:core`, exchanged per run) as a bounded follow-up once the brain is proven. | A long-lived PAT leak is valid until manually revoked/rotated (up to its full lifetime) vs minutes for an OAuth-exchanged token — accepted for now, tracked as the next security step. | Tailscale OAuth clients (short-lived key minting): [OAuth clients](https://tailscale.com/kb/1215/oauth-clients); API access tokens: [API docs](https://tailscale.com/api). |
| **`notify()` is a pluggable stub — journal-only now, Telegram adapter later.** `notify(level, msg)` writes to the journal/stderr always; if `/etc/grok-fleet/telegram.env` (mode 600, `TELEGRAM_BOT_TOKEN=` + `TELEGRAM_CHAT_ID=`) EXISTS, it also POSTs to the Bot API. No bot ⇒ no Telegram, no error. (Q4) | (a) hard-wire Telegram now — LOST: blocks the whole brain on a bot token that doesn't exist yet. (b) email/other — deferred; the interface is pluggable so the transport is swappable. | Hard-wiring an unavailable transport would either crash reconcile or drop alerts silently; the stub degrades to journal-only. | Bot API sendMessage: [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage). |

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

**§5 fact — H12 worker self-join (VERIFIED on r3):** the box-8 r3 truth run
confirmed a Stage-3 worker self-joins in **~17s** on-box (H12 now VERIFIED;
DESIGN.md §5 on `fix/iter3-hotfix-r4` records the same). This blueprint does
NOT depend on that timing (it names the hourly `boxup once`, not the tick, as
the resurrection path) — the fact is recorded for coherence only.
**Merge dependency:** `feat/fleet-brain` will be REBASED onto
`fix/iter3-hotfix-r4` before merge, so the r4 boxup/DESIGN.md/AGENT.md changes
(E1 sha-or-version migration, `converge.v2.lock`, VERSION 5.2.0, F2 DNSName
name-check, F3 OS hostname) are prerequisites of this doc landing.

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
2. **Enroll tunnels box-by-box** (`fleetctl enroll grok-box-N` over **OpenSSH on the tailnet** — `ssh box@grok-box-N …`, since Tailscale SSH is off fleet-wide) while boxes are healthy on the tailnet. **Rollback:** remove the
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

**Expiry-comparison clock (P2-5):** the AUTHORITATIVE auth-key-expiry comparison
(row `c`'s < 7d rotation trigger) is **VPS-side**, against the brain's stable
NTP-synced clock. The box-side H11 `.expires` read runs against the box clock,
which JUMPS on thaw (DESIGN.md "time jump detected"); because the dates are
day-granular ISO and the VPS-side comparison is skew-immune, the box-side read
is advisory only — thaw skew is tolerated and never mis-times a rotation.

---

## Resolved decisions (user rulings, 2026-08-28)

All prior open questions are now RESOLVED — recorded here and reflected in the
wall above.

1. **Both-paths-dead tiering (row e):** T = **2h** (two missed hourly `once`
   windows) → INFORMATIONAL "asleep" alert once, then a daily digest.
   ACTIONABLE incident immediately (after 2 consecutive reconcile runs) when
   the API says the device is online / `lastSeen` fresh yet both paths are
   dead, OR when tunnel-alive + `boxup check` FAIL persists > 3 runs.
2. **API credential:** long-lived write-scoped PAT this iteration (already
   minted, never printed); OAuth-client → short-lived per-run token is the
   tracked follow-up (§4 credential-shape row).
3. **`tag:fleet-brain`:** confirmed, NO exit-node/subnet rights. Operator adds
   `"tag:fleet-brain": ["autogroup:admin"]` to `tagOwners`. `fleetctl enroll`
   PRECHECKS this via `GET /acl` and refuses with a clear message if absent.
4. **`notify()`:** journal-only stub confirmed; Telegram adapter reads
   `/etc/grok-fleet/telegram.env` (600) when present (§4 row).
5. **Ports 20001–20008:** verified free on the VPS loopback — confirmed.
6. **Duplicate-both-online (row b):** confirmed — NEVER auto-delete; flag a
   human.
7. **Box access:** the brain reaches a box ONLY as `box@127.0.0.1 -p 2000N`
   using the VPS's own ed25519 key, enrolled into the box's `authorized_keys`
   at enroll time — NO password fallback in the reconciler — then `sudo boxup
   once/check`; the box's converge lock serializes.

## Prior art / reference URLs

(Consolidated; also inline above.)

- ssh reverse tunnel supervision — [systemd persistent tunnel](https://blog.kylemanna.com/linux/ssh-reverse-tunnel-on-linux-with-systemd/), [autossh systemd unit](https://gist.github.com/ntrepid8/0af12c012dd2567c800799d86eb44f90), [supervisord precedent](https://github.com/imbue-ai/mngr/issues/2423)
- sshd `restrict`/`permitlisten` — [sshd(8) AUTHORIZED_KEYS](https://man.openbsd.org/OpenBSD-current/sshd), [bastion hardening](https://blog.vitalvas.com/post/2026/02/04/reverse-ssh-tunnels/), [permitlisten Q&A](https://superuser.com/questions/1552105/)
- Tailscale API — [keys create / KeyCapabilities](https://api.tailscale.com/api/v2), [terraform tailnet_key defaults](https://github.com/tailscale/terraform-provider-tailscale/blob/main/docs/resources/tailnet_key.md), [remove a device (DELETE)](https://tailscale.com/docs/features/access-control/device-management/how-to/remove), [auth keys / expiry 1–90d](https://tailscale.com/docs/features/access-control/auth-keys), [OAuth clients](https://tailscale.com/kb/1215/oauth-clients), [ACL tags](https://tailscale.com/kb/1068/acl-tags) · Tailscale SSH is OFF fleet-wide (`--ssh=false`, DESIGN.md) — enrollment/first-contact use OpenSSH over the tailnet, not [TS-SSH](https://tailscale.com/kb/1193/tailscale-ssh)
- [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/systemd.timer.html) · [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)
