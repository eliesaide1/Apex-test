"""Persistence seam for sessions, flags, and the latest webcam frame.

Sessions and flags are durable (SQLite, via `db.py`). The latest webcam JPEG is
kept in memory only — it's a live frame refreshed every few seconds, so there's
no value in writing every frame to disk; it simply repopulates after a restart.

The public functions below are the API the rest of the app depends on. Swapping
SQLite for Postgres later means reimplementing this module, nothing else.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from . import db


@dataclass
class Flag:
    type: str
    detail: str | None
    severity: str
    ts: float = field(default_factory=time.time)


@dataclass
class Session:
    id: str
    candidate_name: str
    exam_id: str
    started_at: float
    last_seen: float
    flags: list[Flag] = field(default_factory=list)
    submitted: bool = False
    score: int | None = None
    last_snapshot: bytes | None = None          # latest webcam JPEG (in-memory)
    last_snapshot_ts: float | None = None


# In-memory live frames, keyed by session id. Not persisted (see module docstring).
_snapshots: dict[str, tuple[bytes, float]] = {}


def _row_to_session(row: db.sqlite3.Row, with_flags: bool = True) -> Session:
    snap = _snapshots.get(row["id"])
    s = Session(
        id=row["id"],
        candidate_name=row["candidate_name"],
        exam_id=row["exam_id"],
        started_at=row["started_at"],
        last_seen=row["last_seen"],
        submitted=bool(row["submitted"]),
        score=row["score"],
        last_snapshot=snap[0] if snap else None,
        last_snapshot_ts=snap[1] if snap else None,
    )
    if with_flags:
        s.flags = _load_flags(row["id"])
    return s


def _load_flags(session_id: str) -> list[Flag]:
    rows = db.query(
        "SELECT type, detail, severity, ts FROM flags WHERE session_id=? ORDER BY id",
        (session_id,),
    )
    return [Flag(type=r["type"], detail=r["detail"], severity=r["severity"], ts=r["ts"]) for r in rows]


def create_session(candidate_name: str, exam_id: str) -> Session:
    sid = uuid.uuid4().hex
    now = time.time()
    db.execute(
        "INSERT INTO sessions (id, candidate_name, exam_id, started_at, last_seen, submitted) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (sid, candidate_name, exam_id, now, now),
    )
    return Session(id=sid, candidate_name=candidate_name, exam_id=exam_id,
                   started_at=now, last_seen=now)


def get_session(session_id: str) -> Session | None:
    row = db.query_one("SELECT * FROM sessions WHERE id=?", (session_id,))
    return _row_to_session(row) if row else None


def touch(session_id: str) -> Session | None:
    """Mark the candidate as alive (heartbeat / any activity)."""
    now = time.time()
    cur = db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now, session_id))
    return get_session(session_id) if cur.rowcount else None


def set_snapshot(session_id: str, data: bytes) -> Session | None:
    row = db.query_one("SELECT id FROM sessions WHERE id=?", (session_id,))
    if row is None:
        return None
    now = time.time()
    _snapshots[session_id] = (data, now)
    db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now, session_id))
    return get_session(session_id)


def add_flag(session_id: str, flag: Flag) -> Session | None:
    row = db.query_one("SELECT id FROM sessions WHERE id=?", (session_id,))
    if row is None:
        return None
    db.execute(
        "INSERT INTO flags (session_id, type, detail, severity, ts) VALUES (?, ?, ?, ?, ?)",
        (session_id, flag.type, flag.detail, flag.severity, flag.ts),
    )
    db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (time.time(), session_id))
    return get_session(session_id)


def set_submitted(session_id: str, score: int) -> Session | None:
    cur = db.execute(
        "UPDATE sessions SET submitted=1, score=? WHERE id=?", (score, session_id)
    )
    return get_session(session_id) if cur.rowcount else None


def all_sessions() -> list[Session]:
    rows = db.query("SELECT * FROM sessions ORDER BY started_at")
    return [_row_to_session(r) for r in rows]
