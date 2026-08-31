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
from collections import deque
from dataclasses import dataclass, field

from . import config, db


@dataclass
class Flag:
    type: str
    detail: str | None
    severity: str
    ts: float = field(default_factory=time.time)


@dataclass
class AudioClip:
    seq: int
    data: bytes
    mime: str
    ts: float
    level: float       # 0..1 loudness of this clip, measured in the browser
    ms: int            # clip duration
    speaking: bool = False   # judged talking, not room noise


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
    audio_level: float | None = None            # loudness of the newest clip
    audio_ts: float | None = None               # when that clip arrived
    audio_speaking: bool = False                # newest clip judged as talking


# In-memory live frames, keyed by session id. Not persisted (see module docstring).
_snapshots: dict[str, tuple[bytes, float]] = {}

# In-memory rolling audio buffer, keyed by session id. Same reasoning as frames:
# this is a live listen-in feed, not an archive, so it is never written to disk.
_audio: dict[str, deque[AudioClip]] = {}
_audio_seq: dict[str, int] = {}
# Voice-detection state per session: learned room-noise floor, consecutive loud
# clips, and when we last flagged (for the cooldown).
_voice_floor: dict[str, float] = {}
_voice_clips: dict[str, int] = {}
_voice_run: dict[str, int] = {}
_voice_flagged_at: dict[str, float] = {}

# In-memory proctor->candidate messages, delivered once then cleared.
_messages: dict[str, list[dict]] = {}
_msg_seq = 0


def _row_to_session(row: db.sqlite3.Row, with_flags: bool = True) -> Session:
    snap = _snapshots.get(row["id"])
    clips = _audio.get(row["id"])
    newest = clips[-1] if clips else None
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
        audio_level=newest.level if newest else None,
        audio_ts=newest.ts if newest else None,
        audio_speaking=bool(newest.speaking) if newest else False,
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


# --- live audio ----------------------------------------------------------- #
def add_audio(session_id: str, data: bytes, mime: str, level: float,
              ms: int, speaking: bool = False) -> AudioClip | None:
    """Append a clip to the session's rolling buffer. None if session unknown."""
    row = db.query_one("SELECT id FROM sessions WHERE id=?", (session_id,))
    if row is None:
        return None
    seq = _audio_seq.get(session_id, 0) + 1
    _audio_seq[session_id] = seq
    clip = AudioClip(seq=seq, data=data, mime=mime, ts=time.time(),
                     level=level, ms=ms, speaking=speaking)
    buf = _audio.get(session_id)
    if buf is None:
        buf = _audio[session_id] = deque(maxlen=max(1, config.AUDIO_CLIP_KEEP))
    buf.append(clip)
    db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (clip.ts, session_id))
    return clip


def audio_since(session_id: str, after_seq: int) -> list[AudioClip]:
    """Clips newer than `after_seq`, oldest first (the proctor's play queue)."""
    return [c for c in _audio.get(session_id, ()) if c.seq > after_seq]


def audio_clip(session_id: str, seq: int) -> AudioClip | None:
    for c in _audio.get(session_id, ()):
        if c.seq == seq:
            return c
    return None


def classify_voice(session_id: str, level: float) -> tuple[bool, float, bool]:
    """Decide whether this clip is talking, adapting to the room's noise floor.

    Returns (speaking, threshold, calibrating).

    The first VOICE_CALIBRATE_CLIPS clips learn the room baseline from the
    quietest clip seen, whatever the candidate is doing — without that window a
    room noisier than VOICE_ABS_MIN (a desk fan) is judged as talking from the
    first clip, and since the floor otherwise only learns from non-speech clips
    it could never establish a baseline and would flag forever.

    Afterwards the floor drops quickly toward a new quiet baseline but rises
    only slowly, and only from clips that were not speech, so someone talking
    non-stop cannot train their own threshold upward. VOICE_FLOOR_MAX caps what
    can be learned, which is what stops talking through the whole calibration
    window from disabling detection.
    """
    from . import proctoring   # local import: proctoring holds the pure maths

    n = _voice_clips.get(session_id, 0) + 1
    _voice_clips[session_id] = n
    floor = _voice_floor.get(session_id)

    if n <= config.VOICE_CALIBRATE_CLIPS:
        floor = level if floor is None else min(floor, level)
        floor = _voice_floor[session_id] = min(floor, config.VOICE_FLOOR_MAX)
        threshold = proctoring.speech_threshold(floor)
        # Report the verdict (the meter uses it) but tell the caller we are
        # still calibrating so no flag is raised from these opening clips.
        return level >= threshold, threshold, True

    threshold = proctoring.speech_threshold(floor)
    speaking = level >= threshold

    if not speaking:
        if floor is None:
            floor = level
        elif level < floor:
            floor = floor * 0.7 + level * 0.3      # settle down fast
        else:
            floor = floor * 0.95 + level * 0.05    # creep up slowly
        _voice_floor[session_id] = min(floor, config.VOICE_FLOOR_MAX)

    return speaking, threshold, False


def voice_threshold(session_id: str) -> float:
    """The current speech threshold for this candidate, without judging a clip.

    classify_voice() has side effects (it counts calibration clips and learns
    the noise floor), so a caller that only wants to *report* the threshold —
    e.g. a clip recorded while the proctor was talking, which must not train
    anything — asks here instead.
    """
    from . import proctoring

    return proctoring.speech_threshold(_voice_floor.get(session_id))


def note_voice(session_id: str, speaking: bool) -> bool:
    """Track consecutive speech clips.

    Returns True exactly once per talking episode (after VOICE_MIN_CLIPS
    consecutive loud clips, and at most once per VOICE_COOLDOWN seconds), so the
    caller raises one flag per episode instead of one per clip.
    """
    if not speaking:
        _voice_run[session_id] = 0
        return False
    run = _voice_run.get(session_id, 0) + 1
    _voice_run[session_id] = run
    if run < config.VOICE_MIN_CLIPS:
        return False
    now = time.time()
    if now - _voice_flagged_at.get(session_id, 0.0) < config.VOICE_COOLDOWN:
        return False
    _voice_flagged_at[session_id] = now
    return True


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


def set_submitted(session_id: str, score: int | None = None) -> Session | None:
    cur = db.execute(
        "UPDATE sessions SET submitted=1, score=? WHERE id=?", (score, session_id)
    )
    return get_session(session_id) if cur.rowcount else None


def all_sessions() -> list[Session]:
    rows = db.query("SELECT * FROM sessions ORDER BY started_at")
    return [_row_to_session(r) for r in rows]


# --- free-text answers ---------------------------------------------------- #
def save_answer(session_id: str, question_id: str, answer: str) -> bool:
    """Upsert a single question's answer. Returns False if session unknown."""
    if db.query_one("SELECT id FROM sessions WHERE id=?", (session_id,)) is None:
        return False
    db.execute(
        "INSERT INTO answers (session_id, question_id, answer, updated_at) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(session_id, question_id) DO UPDATE SET "
        "answer=excluded.answer, updated_at=excluded.updated_at",
        (session_id, question_id, answer, time.time()),
    )
    db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (time.time(), session_id))
    return True


def get_answers(session_id: str) -> dict[str, dict]:
    """question_id -> {'answer': str, 'updated_at': float}."""
    rows = db.query(
        "SELECT question_id, answer, updated_at FROM answers WHERE session_id=?",
        (session_id,),
    )
    return {r["question_id"]: {"answer": r["answer"], "updated_at": r["updated_at"]}
            for r in rows}


def get_flags_detailed(session_id: str) -> list[dict]:
    """Flags with their DB ids, newest first (for the proctor's review panel)."""
    rows = db.query(
        "SELECT id, type, detail, severity, ts FROM flags WHERE session_id=? "
        "ORDER BY ts DESC", (session_id,))
    return [{"id": r["id"], "type": r["type"], "detail": r["detail"],
             "severity": r["severity"], "ts": r["ts"]} for r in rows]


def delete_flag(session_id: str, flag_id: int) -> bool:
    cur = db.execute("DELETE FROM flags WHERE id=? AND session_id=?",
                     (flag_id, session_id))
    return cur.rowcount > 0


def clear_flags(session_id: str) -> int:
    cur = db.execute("DELETE FROM flags WHERE session_id=?", (session_id,))
    return cur.rowcount


def add_message(session_id: str, text: str) -> bool:
    """Queue a proctor message for the candidate. False if session unknown."""
    global _msg_seq
    if db.query_one("SELECT id FROM sessions WHERE id=?", (session_id,)) is None:
        return False
    _msg_seq += 1
    _messages.setdefault(session_id, []).append(
        {"id": _msg_seq, "text": text, "ts": time.time()})
    return True


def pop_messages(session_id: str) -> list[dict]:
    """Return and clear the candidate's pending messages (deliver-once)."""
    return _messages.pop(session_id, [])


def name_key(name: str) -> str:
    """The identity a removal is remembered by.

    Candidates type their own name, so match it the way a person reading the
    list would: case-insensitive, and indifferent to stray whitespace. This is
    a deterrent, not proof of identity — someone determined can type a
    different name, which is exactly the limit the README describes and what
    per-candidate accounts would fix.
    """
    return " ".join(name.split()).casefold()


def block_candidate(name: str) -> None:
    """Bar this name from starting the exam again."""
    db.execute(
        "INSERT OR REPLACE INTO removals (name_key, candidate_name, removed_at) "
        "VALUES (?, ?, ?)",
        (name_key(name), " ".join(name.split()), time.time()),
    )


def is_blocked(name: str) -> bool:
    return db.query_one("SELECT 1 FROM removals WHERE name_key=?",
                        (name_key(name),)) is not None


def unblock_candidate(key: str) -> bool:
    """Let a removed candidate back in (the proctor removed them by mistake)."""
    return db.execute("DELETE FROM removals WHERE name_key=?", (key,)).rowcount > 0


def removals() -> list[dict]:
    rows = db.query("SELECT name_key, candidate_name, removed_at FROM removals "
                    "ORDER BY removed_at DESC")
    return [dict(r) for r in rows]


def delete_session(session_id: str) -> bool:
    """Remove a session and (via FK cascade) its flags and answers."""
    _snapshots.pop(session_id, None)
    _audio.pop(session_id, None)
    _audio_seq.pop(session_id, None)
    _voice_floor.pop(session_id, None)
    _voice_clips.pop(session_id, None)
    _voice_run.pop(session_id, None)
    _voice_flagged_at.pop(session_id, None)
    _messages.pop(session_id, None)
    cur = db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
    return cur.rowcount > 0


def count_answers(session_id: str) -> int:
    row = db.query_one(
        "SELECT COUNT(*) AS n FROM answers WHERE session_id=? AND TRIM(answer) <> ''",
        (session_id,),
    )
    return row["n"] if row else 0
