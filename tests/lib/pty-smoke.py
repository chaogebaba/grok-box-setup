#!/usr/bin/env python3
"""pty-smoke.py — drive a program under a REAL pty and report what it painted.

`script` is not installed on every machine this repo is developed on, so the
TUI smoke forks its own pty. Usage:

    pty-smoke.py <expect-timeout-s> <send-after-match> <raw-out-path> -- cmd [args...]

It waits up to <expect-timeout-s> for the child to paint something, then sends
<send-after-match> (may be empty), waits for the child to exit, and prints one
KEY=VALUE line per fact for the shell to assert on. The raw pty bytes are
written to <raw-out-path>.
"""
import fcntl, os, pty, re, select, struct, sys, termios, time

# The TUI paints its header in per-cell colours since 5.7.2, so `grokfleet` and the
# box count are separated by SGR bytes on the wire. Match the TEXT the terminal
# would show, not the raw stream — the raw stream is still what the alt-screen
# and cursor assertions below read.
SGR = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")

def visible(b):
    return SGR.sub(b"", b)

timeout = float(sys.argv[1])
send = sys.argv[2]
raw_path = sys.argv[3]
assert sys.argv[4] == "--"
argv = sys.argv[5:]

ROWS, COLS = 40, 120

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

out = b""
deadline = time.time() + timeout
sent = False
while True:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        out += d
    now = time.time()
    if not sent and (b"grokfleet 0 boxes" in visible(out) and b"LINK DOWN" in visible(out)) and send != "":
        os.write(fd, send.encode())
        sent = True
        deadline = now + timeout
    if now > deadline:
        break

if send != "" and not sent:
    # never painted what we waited for; kill the child so the test still ends.
    try:
        os.kill(pid, 9)
    except OSError:
        pass

# drain whatever is left after the quit key.
drain_until = time.time() + 2
while time.time() < drain_until:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        break
    try:
        d = os.read(fd, 65536)
    except OSError:
        break
    if not d:
        break
    out += d

# Wait for the child, but never block forever: a TUI that fails to tear down is
# a FAILURE to report, not a hung test run.
rc = None
wait_until = time.time() + 5
while time.time() < wait_until:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done == pid:
        rc = os.waitstatus_to_exitcode(status)
        break
    time.sleep(0.05)
if rc is None:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    rc = -999  # the process never ended on its own

with open(raw_path, "wb") as f:
    f.write(out)

def idx(needle):
    return out.find(needle)

alt_on, alt_off = idx(b"\x1b[?1049h"), idx(b"\x1b[?1049l")
# The cursor is hidden/shown around every synchronized-output block, so what
# matters is a SHOW that lands after the alt screen was left — Ink's unmount
# order — not the first one in the stream.
cursor_on = out.find(b"\x1b[?25h", alt_off) if alt_off >= 0 else -1
print("RC=%d" % rc)
print("SENT=%d" % (1 if sent else 0))
print("SAW_HEADER=%d" % (1 if b"grokfleet 0 boxes" in visible(out) else 0))
print("SAW_LINKDOWN=%d" % (1 if b"LINK DOWN" in visible(out) else 0))
print("ALT_ON=%d" % alt_on)
print("ALT_OFF=%d" % alt_off)
print("CURSOR_ON=%d" % cursor_on)
print("BYTES=%d" % len(out))
