#!/usr/bin/env python3
"""seatgate.py — shared supervisor seat-gate library for python hooks (F519 #374).

DRY consolidation of the ``is_supervisor_seat()`` verdict that was maintained in
parallel by m1-edit-guard.py (F344, with a fail-CLOSED marker cache), and by
m8-suite-guard.py / m9-cwd-guard.py (plain, fail-OPEN).

Import from a sibling ``lib/`` dir:

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
    from seatgate import is_supervisor_seat            # m8/m9 flavour
    from seatgate import is_supervisor_seat_cached      # m1 flavour (F344)

---------------------------------------------------------------------------
Discriminator (mirrors the pre-consolidation hooks exactly): CAO_TERMINAL_ID
resolves via the CAO sqlite DB (``terminals.agent_profile``, opened read-only)
to an agent-store profile whose frontmatter carries ``role: supervisor``. This
is the SAME mechanism the python guards used; it is intentionally DISTINCT from
the shell lib's HTTP caller_id check (the two answer the same question by
different means — see the F519 build report). Both python surfaces read/write
the same marker location so the DB-role verdict is computed once per terminal.

Failure posture (BEST-PRACTICE BAR, F519):
  * is_supervisor_seat        — FAIL-OPEN: any DB/store exception → False
                                (m8/m9 semantics, byte-for-byte).
  * is_supervisor_seat_cached — FAIL-CLOSED once seen (F344/#199): a positive
                                verdict is cached as a marker file and honored on
                                any later DB exception OR False answer (m1
                                semantics, byte-for-byte).
This lib only answers "is this the supervisor seat"; it NEVER denies. The
wrapped guard keeps its own fail-closed deny semantics.
"""
from __future__ import annotations

import datetime
import re
import sqlite3
from pathlib import Path

# ---------------------------------------------------------------------------
# Default locations (module constants so tests can patch them).
# ---------------------------------------------------------------------------
CAO_DB = Path.home() / ".aws/cli-agent-orchestrator/db/cli-agent-orchestrator.db"
AGENT_STORE = Path.home() / ".aws/cli-agent-orchestrator/agent-store"
# F344 (#199): marker dir for cached POSITIVE seat verdicts. Shared single
# location for the python-side verdict.
SEAT_MARKER_DIR = Path.home() / ".aws/cli-agent-orchestrator"
# Optional decisive trace (m1 parity). Best-effort; never blocks the hook.
SEAT_LOG = Path.home() / ".aws/cli-agent-orchestrator/seatgate.log"

_ROLE_RE = re.compile(r"^role:\s*supervisor\s*$", re.MULTILINE)


def _log(line: str) -> None:
    """Best-effort decisive trace; never raises (F344 parity)."""
    try:
        with SEAT_LOG.open("a") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {line}\n")
    except Exception:
        pass


def _seat_marker(terminal_id: str, marker_dir: Path = SEAT_MARKER_DIR) -> Path:
    return marker_dir / f"m1-seat-{terminal_id}"


def _db_role_verdict(terminal_id: str, db: Path, store: Path) -> bool:
    """Raw DB+frontmatter verdict. Raises on DB/store failure (callers decide
    the failure posture)."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1.0)
    try:
        row = conn.execute(
            "select agent_profile from terminals where id = ?", (terminal_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        # Sentinel: DB reachable but no profile row. Distinct from an exception
        # (which the fail-closed caller treats differently).
        raise _NoProfile()
    head = (store / f"{row[0]}.md").read_text()[:2000]
    return bool(_ROLE_RE.search(head))


class _NoProfile(Exception):
    """DB reachable, terminal row/profile missing (not a transient failure)."""


def is_supervisor_seat(
    terminal_id: str,
    db: Path = CAO_DB,
    store: Path = AGENT_STORE,
) -> bool:
    """FAIL-OPEN seat verdict (m8-suite-guard / m9-cwd-guard semantics).

    True only when the terminal's profile has ``role: supervisor``. Any DB or
    store failure, or a missing profile row, → False. Byte-for-byte equivalent
    of the inline ``is_supervisor_seat`` those two guards carried.
    """
    try:
        return _db_role_verdict(terminal_id, db, store)
    except _NoProfile:
        return False
    except Exception:
        return False


def is_supervisor_seat_cached(
    terminal_id: str,
    db: Path = CAO_DB,
    store: Path = AGENT_STORE,
    marker_dir: Path = SEAT_MARKER_DIR,
) -> bool:
    """FAIL-CLOSED seat verdict (m1-edit-guard / F344 / #199 semantics).

    True when the terminal's profile has ``role: supervisor``. Once a terminal id
    has been seen as a supervisor seat the positive verdict is cached as a marker
    file (``m1-seat-<tid>``) and honored on any later DB exception OR a False/empty
    answer — i.e. transient DB failure fails CLOSED. Byte-for-byte equivalent of
    m1-edit-guard.is_supervisor_seat.
    """
    marker = _seat_marker(terminal_id, marker_dir)
    try:
        verdict = _db_role_verdict(terminal_id, db, store)
    except _NoProfile:
        # DB reachable, no profile row: honor a prior positive marker (fail-closed).
        if marker.exists():
            _log(f"seat marker hit (db-empty) tid={terminal_id} -> fail closed")
            return True
        return False
    except Exception:
        if marker.exists():
            _log(f"seat marker hit (db-error) tid={terminal_id} -> fail closed")
            return True
        _log(f"seat db-error, no marker tid={terminal_id} -> fail open")
        return False

    if verdict:
        try:
            marker_dir.mkdir(parents=True, exist_ok=True)
            marker.touch()
            _log(f"seat verdict=True, marker cached tid={terminal_id}")
        except Exception:
            _log(f"seat marker write failed tid={terminal_id}")
        return True
    # DB answered False: honor a prior positive marker (fail-closed).
    if marker.exists():
        _log(f"seat marker hit (db-false) tid={terminal_id} -> fail closed")
        return True
    return False
