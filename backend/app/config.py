"""Runtime configuration, read from environment variables.

Every deployable secret/toggle lives here so nothing sensitive is hardcoded.
On a managed platform (Render/Railway/Fly) set these in the dashboard.
"""
from __future__ import annotations

import os


def _get(name: str, default: str) -> str:
    return os.getenv(name, default)


# Shared secret used to sign auth tokens (HMAC). MUST be set to a long random
# value in production; the default only exists so local dev runs out of the box.
SECRET_KEY: str = _get("SECRET_KEY", "dev-insecure-change-me")

# Password a proctor types to reach the live dashboard.
PROCTOR_PASSWORD: str = _get("PROCTOR_PASSWORD", "proctor")

# Code candidates enter to start the exam.
EXAM_CODE: str = _get("EXAM_CODE", "APEX-TEST").strip().upper()

# SQLite file location. On managed platforms point this at a mounted disk so it
# survives redeploys, e.g. /var/data/apex.db.
DB_PATH: str = _get("DB_PATH", "data/apex.db")

# Directory holding the built frontend (Vite `dist`). Served by the backend so
# the whole app is one HTTPS origin. Empty => don't serve static (API-only dev).
FRONTEND_DIST: str = _get("FRONTEND_DIST", "")

# Extra CORS origins (comma-separated). Only needed if you host the frontend on
# a DIFFERENT origin than the backend. Single-origin deploys can leave this unset.
_origins = _get("ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS: list[str] = [o.strip() for o in _origins.split(",") if o.strip()]

# Token lifetimes (seconds).
CANDIDATE_TOKEN_TTL: int = int(_get("CANDIDATE_TOKEN_TTL", str(6 * 60 * 60)))
PROCTOR_TOKEN_TTL: int = int(_get("PROCTOR_TOKEN_TTL", str(12 * 60 * 60)))

# --- live audio monitoring ------------------------------------------------- #
# How many recent audio clips to keep per candidate (in memory). Clips are ~4s
# of Opus at ~24kbps (~12 KB each), so the default is well under 150 KB/session.
AUDIO_CLIP_KEEP: int = int(_get("AUDIO_CLIP_KEEP", "10"))

# Voice detection. The browser sends a 0..1 loudness level with each clip and we
# compare it against a threshold that adapts to that candidate's own room noise,
# because absolute levels vary hugely with microphone hardware and gain.
#
# A clip counts as speech when it is louder than BOTH:
#   - VOICE_ABS_MIN          (so a silent room never flags), and
#   - noise floor * VOICE_RATIO (so a noisy room needs a bigger jump)
# The floor only learns from clips that were NOT speech, so someone talking
# continuously from the start cannot quietly raise their own bar.
VOICE_ABS_MIN: float = float(_get("VOICE_ABS_MIN", "0.045"))
VOICE_RATIO: float = float(_get("VOICE_RATIO", "3.0"))
# Opening clips used to learn the room baseline. Until the floor is calibrated a
# room whose noise already exceeds VOICE_ABS_MIN (a fan, say) would be judged as
# talking forever and never get the chance to establish its own floor.
VOICE_CALIBRATE_CLIPS: int = int(_get("VOICE_CALIBRATE_CLIPS", "3"))
# Ceiling on the learned floor. Without it, a candidate talking through the whole
# calibration window would train their own threshold up out of reach. A real room
# baseline this loud is not a usable exam environment anyway.
VOICE_FLOOR_MAX: float = float(_get("VOICE_FLOOR_MAX", "0.05"))
# Consecutive speech clips before a flag is raised (at ~4s/clip, 2 => ~8s of talking).
VOICE_MIN_CLIPS: int = int(_get("VOICE_MIN_CLIPS", "2"))
# Seconds to wait before flagging the same session for talking again.
VOICE_COOLDOWN: int = int(_get("VOICE_COOLDOWN", "45"))
