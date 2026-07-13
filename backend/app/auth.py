"""Lightweight, dependency-free auth: HMAC-signed bearer tokens.

Two roles:
  - "candidate": token `sub` is their session_id, so they can only act on their
    own exam session (flag / snapshot / submit / heartbeat).
  - "proctor":   issued after a correct PROCTOR_PASSWORD; gates the dashboard,
    the session list, live snapshots, and the proctor WebSocket.

No JWT library needed — a compact `base64url(payload).base64url(hmac)` token
signed with SECRET_KEY. Good enough for internal, medium-stakes use.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from fastapi import Header, HTTPException

from . import config


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(txt: str) -> bytes:
    pad = "=" * (-len(txt) % 4)
    return base64.urlsafe_b64decode(txt + pad)


def _sign(payload_b64: str) -> str:
    sig = hmac.new(config.SECRET_KEY.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return _b64e(sig)


def make_token(role: str, sub: str, ttl: int) -> str:
    payload = {"role": role, "sub": sub, "exp": int(time.time()) + ttl}
    payload_b64 = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    return f"{payload_b64}.{_sign(payload_b64)}"


def verify_token(token: str) -> dict:
    """Return the token payload, or raise 401 if invalid/expired."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        raise HTTPException(status_code=401, detail="Malformed token")
    if not hmac.compare_digest(sig, _sign(payload_b64)):
        raise HTTPException(status_code=401, detail="Bad token signature")
    try:
        payload = json.loads(_b64d(payload_b64))
    except Exception:
        raise HTTPException(status_code=401, detail="Bad token payload")
    if payload.get("exp", 0) < time.time():
        raise HTTPException(status_code=401, detail="Token expired")
    return payload


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return authorization[7:].strip()


# --- FastAPI dependencies ------------------------------------------------- #
def require_proctor(authorization: str | None = Header(default=None)) -> dict:
    payload = verify_token(_bearer(authorization))
    if payload.get("role") != "proctor":
        raise HTTPException(status_code=403, detail="Proctor role required")
    return payload


def require_candidate(authorization: str | None = Header(default=None)) -> dict:
    payload = verify_token(_bearer(authorization))
    if payload.get("role") != "candidate":
        raise HTTPException(status_code=403, detail="Candidate role required")
    return payload
