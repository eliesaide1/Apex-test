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
