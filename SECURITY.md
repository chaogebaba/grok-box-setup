# Security

- Never commit `state/tailscale/`, `secrets/ts-authkey`, or `hostname`.
  Those are a live Tailscale node identity.
- Auth keys accepted by `install.sh` must be reusable and **non-ephemeral**.
  Ephemeral keys vanish on restart and mint a new node.
- OpenSSH on this box is password-based by platform contract (`box` / `root`).
  Treat the tailnet as the trust boundary; do not bind sshd to the public WAN
  on purpose. Tailscale SSH (`--ssh`) stays off — OpenSSH only.
- Report issues that leak statedir or auth keys as a security problem, not
  a feature request.
