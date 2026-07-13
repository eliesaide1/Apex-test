"""SQLite persistence for sessions and flags.

Single-connection, WAL mode, guarded by a lock — correct for the single-worker
deployment this app targets. (Move to Postgres only if you need multiple backend
workers; `store.py` is the seam that would change, not the rest of the app.)
"""
from __future__ import annotations

import os
import sqlite3
import threading

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    path = config.DB_PATH
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init() -> None:
    """Open the connection and create tables. Call once at startup."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = _connect()
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id            TEXT PRIMARY KEY,
                candidate_name TEXT NOT NULL,
                exam_id       TEXT NOT NULL,
                started_at    REAL NOT NULL,
                last_seen     REAL NOT NULL,
                submitted     INTEGER NOT NULL DEFAULT 0,
                score         INTEGER
            );
            CREATE TABLE IF NOT EXISTS flags (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                type       TEXT NOT NULL,
                detail     TEXT,
                severity   TEXT NOT NULL,
                ts         REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_flags_session ON flags(session_id);
            """
        )
        _conn.commit()


def conn() -> sqlite3.Connection:
    if _conn is None:
        init()
    assert _conn is not None
    return _conn


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        cur = conn().execute(sql, params)
        conn().commit()
        return cur


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    with _lock:
        return conn().execute(sql, params).fetchone()
