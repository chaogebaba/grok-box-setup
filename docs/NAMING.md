# Naming

Pattern: `grok-box-<N>` with N = 1, 2, 3, … no cap.

You **cannot** decide N while the node is `NeedsLogin`. The tailnet roster is
invisible until the human clicks Connect (or an auth-key `up` succeeds).
First `up` may leave Self named `cursor`. That is temporary.

Do not use: `grok-exit`, bare `grok-box`, `cursor`, `cursor-N`.

## When to name

| State | What you do |
|---|---|
| `NeedsLogin` / AuthURL present | Paste the URL. Stop. Do not invent a name. |
| Statedir kilobytes **and** hostname file already `grok-box-N` **and** `prefs.Hostname` matches the file | Keep it. Do not bump. |
| Backend Running, first join, hostname file missing / not `grok-box-N` | List tailnet → next free N → write file → `set`. |
| Restore after image swap, statedir survived | Keep the name. Do not list-and-bump. |

## How to pick N (after login)

```bash
timeout 8 tailscale status --json
timeout 8 tailscale ip -4
timeout 8 tailscale status
```

JSON `HostName` is **not** MagicDNS. A peer with `HostName=grok-box` may still
be `grok-box-2` in DNS / column 1 of `tailscale status`.

Taken N = any name matching `^grok-box-[0-9]+$` on **other** machines, online
or offline, from **all** of:

1. each peer JSON `HostName`
2. each peer JSON `DNSName` first label (strip `.tail….ts.net.`)
3. column 1 of `tailscale status` for every row whose IP is **not** this node’s `tailscale ip -4`

```
n = 1
while grok-box-n is taken: n += 1
NAME = grok-box-n
```

Do **not** count Self. After first Connect, Self is often `HostName=cursor`.
That must not consume `grok-box-1`.

`scripts/lib/naming.sh` implements this. Prefer it over a hand-rolled parser.

## Apply the name

Forwarding must already be `4:1,6:1`. Then:

```bash
echo "$NAME" > /workspace/box-setup/hostname
sudo -u box tailscale set --hostname="$NAME" --ssh=false --operator=box \
  --advertise-exit-node --snat-subnet-routes=true --stateful-filtering=false
```

If `set` races another new box and the name is taken, increment N and `set`
again. Print the peer `grok-box-*` list and the chosen `NAME` once.
Do not ask the human to pick N.
