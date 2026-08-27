# RUNBOOK — procedures

Companion to [`AGENT.md`](AGENT.md) (how to use the repo) and
[`ARCHITECTURE.md`](ARCHITECTURE.md) (why). Naming algorithm:
[`NAMING.md`](NAMING.md). Failures: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

You are the agent on this box. Follow the matching section. Then stop.
No extra narration when healthy.

```bash
sudo /workspace/box-setup/box-bootstrap.sh --once     # ensure + one tick
sudo /workspace/box-setup/box-bootstrap.sh --status
sudo /workspace/box-setup/box-bootstrap.sh --stop     # every selfheal worker; tailscaled stays
sudo /workspace/box-setup/health-tick-forward.sh      # forwarding/NAT/Hostinfo
```

## Which procedure?

| Situation | Section |
|---|---|
| Brand-new box, empty statedir | [A](#a-new-box) |
| Same image, woke from sleep | [B](#b-wake) |
| Image swapped, workspace came back | [C](#c-restore) |
| Hourly external wake | [D](#d-keep-alive) |
| Check health | [E](#e-verify) |
| Console says cannot relay / forwarding disabled | [G](#g-cannot-relay) |

---

## A. New box

Only when `state/tailscale/tailscaled.state` is missing or ~empty **and**
Tailscale is `Logged out` / `NeedsLogin`.

### A0. Seed

`install.sh` already did this. Do **not** copy another box’s `state/`.
Do **not** write a final `grok-box-N` yet.

### A1. Bootstrap

```bash
sudo /workspace/box-setup/box-bootstrap.sh --once
sudo /workspace/box-setup/box-bootstrap.sh --status
```

### A2. Human Connect

If `--status` has `auth=https://login.tailscale.com/…`:

- Paste that URL.
- Tell them: sign in, click **Connect**, say when done.
- **Stop.** Do not run `tailscale login`. Do not pick a name.

When Connected (or auth-key `up` already made `backend=Running`):
`tailscaled.state` is kilobytes. Go to A3. Do not mint a new AuthURL.

### A3. Name + prefs

```bash
sudo /workspace/box-setup/ensure-ip-forward.sh    # must print ipfwd=4:1,6:1
timeout 8 tailscale status --json
```

Compute `NAME` with [`NAMING.md`](NAMING.md). Then:

```bash
echo "$NAME" > /workspace/box-setup/hostname
sudo -u box tailscale set --hostname="$NAME" --ssh=false --operator=box \
  --advertise-exit-node --snat-subnet-routes=true --stateful-filtering=false
sudo /workspace/box-setup/box-bootstrap.sh --status
```

### A4. Exit-node approval — once per box

Human: https://login.tailscale.com/admin/machines → this `$NAME` →
**Use as exit node** / approve both `0.0.0.0/0` and `::/0`.

Until that is approved, status will not show `offers exit node`.
If the orange “Unable to relay traffic” banner remains after approval, that
is [G](#g-cannot-relay), not a missing click.

### A5. Hourly wake

Section D.

---

## B. Wake

```bash
sudo /workspace/box-setup/box-bootstrap.sh --once
```

If the line is `backend=Running online=yes exit-node=yes sshd=up` and
forwarding is `4:1,6:1`, stop. No kill commands. No new AuthURL. No hostname bump.

If the line is `backend=Running online=no` after a freeze, `--once`
recycles **that** `tailscaled` PID (same statedir). A freeze is also
detected from hb age ≥ 60s even while `online=yes` (map timeout lags).
Wait for `--status` `online=yes`. No new AuthURL. No hostname bump.

If the line is healthy but forwarding is 0, run
`sudo /workspace/box-setup/health-tick-forward.sh` and stop.

---

## C. Restore after image swap

Apt, `/usr/local`, `/etc/sysctl.d`, nft tables, and the start hook are gone.
`/workspace/box-setup/` (statedir + hostname + scripts + bins) comes back.
Forwarding is 0 until the first tick.

```bash
sudo /workspace/box-setup/box-bootstrap.sh --once
```

Same node: same `grok-box-N`, same 100.x. No Connect. No auth key.
No new route approval. No list-and-bump.

`NeedsLogin` only if `state/tailscale` is empty or corrupt → A.

---

## D. Keep-alive

Automation on **this** box:

- Name: `Box keep-alive`
- Schedule: hourly, 24/7
- Prompt — paste verbatim:

```
Keep this box's Tailscale exit node and OpenSSH healthy. Do only this.

Run, in order:
sudo /workspace/box-setup/health-tick-forward.sh
sudo /workspace/box-setup/box-bootstrap.sh --once

Print the stdout status line and the ipfwd= line.

Rules:
- If online=yes AND exit-node=yes AND sshd=up AND ipfwd shows 4:1,6:1 (or both /proc/sys forwarding files are 1): stop. No narration.
- If backend=Running AND online=no: --once recycles that tailscaled PID. Print the new status line. If still online=no after one --once, stop. Not NeedsLogin. Do not invent kill commands.
- If ipfwd is 4:0 or 6:0: run health-tick-forward.sh one more time. If still 0, say "sysctl write failed — container netns may lack NET_ADMIN" and stop. Do not invent kill commands. Do not treat this as NeedsLogin.
- If the line has auth=https://login.tailscale.com/ : paste that URL and stop. Do not run tailscale login or tailscale up.
- If the line has NeedsLogin or backend=NoState: check size with `sudo wc -c /workspace/box-setup/state/tailscale/tailscaled.state` (mode 600 root; a non-sudo read from `box` looks empty). Kilobytes ⇒ login is saved. Wait a few seconds on NoState, then `--status`. Do not ask the human to Connect or for an auth key. --once is enough.
- Call /workspace/box-setup helpers only. Not /usr/local/sbin/... (gone after image swap).
- Never: pkill, systemctl, cron, a second tailscaled, a partial tailscale up, Tailscale SSH, invent kill commands.
```

---

## E. Verify

`nc` and `ping` are not on this image. Use python for the SSH banner.

```bash
NAME=$(tr -d '[:space:]' < /workspace/box-setup/hostname)
TS4=$(tailscale ip -4)
sudo /workspace/box-setup/box-bootstrap.sh --status
tailscale status
echo "NAME=$NAME TS4=$TS4"
cat /proc/sys/net/ipv4/ip_forward          # 1
cat /proc/sys/net/ipv6/conf/all/forwarding # 1
sudo /workspace/box-setup/ensure-ip-forward.sh
curl -sS --unix-socket /var/run/tailscale/tailscaled.sock \
  http://local-tailscaled.sock/localapi/v0/check-ip-forwarding || true
sudo nft list table ip ts-exitfix
ss -lntH | awk '{print $4}' | grep -E ':22$'
sudo passwd -S box root   # P, not L
sudo wc -c /workspace/box-setup/state/tailscale/tailscaled.state
tr '\0' '\n' < /proc/$(pgrep -n -x tailscaled)/cmdline
timeout 8 tailscale debug prefs | python3 -c 'import json,sys; p=json.load(sys.stdin); print({k:p.get(k) for k in ["Hostname","OperatorUser","RunSSH","AdvertiseRoutes","NoSNAT","NoStatefulFiltering","WantRunning","CorpDNS"]})'
timeout 8 tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("Self") or {}; print({"BackendState": d.get("BackendState"), "HostName": s.get("HostName"), "DNSName": s.get("DNSName"), "Online": s.get("Online"), "ExitNodeOption": s.get("ExitNodeOption"), "Health": d.get("Health")})'
```

Phone: exit node = this `grok-box-N`, then https://ifconfig.me.
nft `ts-exitfix` masquerade counters increment when exit traffic flows.

---

## G. Cannot relay

Orange admin dialog on `grok-box-N`:

> Unable to relay traffic — This machine has IP forwarding disabled

This is **not** a new machine, not an expired key, not a missing hostname.

```bash
sudo /workspace/box-setup/health-tick-forward.sh
sudo /workspace/box-setup/box-bootstrap.sh --once
cat /proc/sys/net/ipv4/ip_forward
cat /proc/sys/net/ipv6/conf/all/forwarding
curl -sS --unix-socket /var/run/tailscale/tailscaled.sock \
  http://local-tailscaled.sock/localapi/v0/check-ip-forwarding
timeout 8 tailscale status
```

Both forwarding files must be `1`. `check-ip-forwarding` must not say
`disabled`. Status should say **offers exit node**.

If `/proc` writes fail: netns lacks `NET_ADMIN`. Say that. Do not switch to
userspace networking.

If kernel is 1 but the console still warns: Hostinfo is stale. Wait ~30s and
reload the machine page. Do **not** `tailscale up` again. Confirm with a phone
and nft masquerade counters — Docker can leave a false-positive banner
(tailscale#14506) while relay works.

Selfheal + section D keep it cured. Do not add cron. Do not add a second supervisor.
