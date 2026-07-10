"""In-memory data store for the MVP.

Swap this module for PostgreSQL (sessions, flags, snapshots) + Redis (pub/sub
of live flags to proctor dashboards) when you move past the prototype. The public
functions below are the seam to keep.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field


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
    started_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    flags: list[Flag] = field(default_factory=list)
    submitted: bool = False
    score: int | None = None
    last_snapshot: bytes | None = None          # latest webcam JPEG
    last_snapshot_ts: float | None = None


_sessions: dict[str, Session] = {}


def create_session(candidate_name: str, exam_id: str) -> Session:
    sid = uuid.uuid4().hex
    s = Session(id=sid, candidate_name=candidate_name, exam_id=exam_id)
    _sessions[sid] = s
    return s


def get_session(session_id: str) -> Session | None:
    return _sessions.get(session_id)


def touch(session_id: str) -> Session | None:
    """Mark the candidate as alive (heartbeat / any activity)."""
    s = _sessions.get(session_id)
    if s is not None:
        s.last_seen = time.time()
    return s


def set_snapshot(session_id: str, data: bytes) -> Session | None:
    s = _sessions.get(session_id)
    if s is None:
        return None
    s.last_snapshot = data
    s.last_snapshot_ts = time.time()
    s.last_seen = s.last_snapshot_ts
    return s


def add_flag(session_id: str, flag: Flag) -> Session | None:
    s = _sessions.get(session_id)
    if s is None:
        return None
    s.flags.append(flag)
    s.last_seen = time.time()
    return s


def all_sessions() -> list[Session]:
    return list(_sessions.values())
