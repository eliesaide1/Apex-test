"""ApexTestPortal backend — FastAPI.

Candidate endpoints (require a candidate bearer token, issued at /api/login and
scoped to that one session):
    POST /api/login              -> start a session; returns token + exam (no keys)
    POST /api/flag               -> record a cheating flag; broadcast to proctors
    POST /api/snapshot           -> upload webcam frame; AI-analyze; flag if needed
    POST /api/submit             -> grade the exam
    POST /api/heartbeat          -> liveness ping

Proctor endpoints (require a proctor bearer token, issued at /api/proctor/login):
    GET  /api/sessions           -> list sessions + flags
    GET  /api/snapshot/{id}      -> latest webcam frame
    WS   /ws/proctor?token=...   -> live stream of flags

The built frontend is served from FRONTEND_DIST so the whole app is one origin.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

from fastapi import (
    FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect,
    Depends, Header, HTTPException,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import store, exam_data, config, db
from .auth import (
    make_token, verify_token, require_proctor, require_candidate,
)
from .models import (
    LoginRequest, LoginResponse, FlagRequest, AnswerRequest,
    SubmitRequest, SubmitResponse,
)
from .proctoring import analyze_snapshot

app = FastAPI(title="ApexTestPortal")

if config.ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.on_event("startup")
def _startup() -> None:
    db.init()


# --------------------------------------------------------------------------- #
# Live proctor connections
# --------------------------------------------------------------------------- #
class ProctorHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast(self, message: dict) -> None:
        dead = []
        for ws in self._clients:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


hub = ProctorHub()


def _flag_event(session: store.Session, flag: store.Flag) -> dict:
    return {
        "kind": "flag",
        "session_id": session.id,
        "candidate_name": session.candidate_name,
        "type": flag.type,
        "detail": flag.detail,
        "severity": flag.severity,
        "ts": flag.ts,
        "total_flags": len(session.flags),
    }


def _require_own_session(token: dict, session_id: str) -> None:
    """A candidate token may only act on the session it was issued for."""
    if token.get("sub") != session_id:
        raise HTTPException(status_code=403, detail="Token/session mismatch")


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
class ProctorLogin(BaseModel):
    password: str


@app.post("/api/proctor/login")
async def proctor_login(req: ProctorLogin):
    import hmac
    if not hmac.compare_digest(req.password, config.PROCTOR_PASSWORD):
        raise HTTPException(status_code=403, detail="Invalid proctor password")
    return {"token": make_token("proctor", "proctor", config.PROCTOR_TOKEN_TTL)}


# --------------------------------------------------------------------------- #
# Candidate endpoints
# --------------------------------------------------------------------------- #
@app.post("/api/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    if req.exam_code.strip().upper() != exam_data.EXAM_CODE:
        raise HTTPException(status_code=403, detail="Invalid exam code")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name required")

    session = store.create_session(req.name.strip(), exam_data.EXAM["id"])
    token = make_token("candidate", session.id, config.CANDIDATE_TOKEN_TTL)
    return LoginResponse(
        session_id=session.id,
        candidate_name=session.candidate_name,
        token=token,
        exam=exam_data.public_exam(),
    )


@app.post("/api/flag")
async def flag(req: FlagRequest, token: dict = Depends(require_candidate)):
    _require_own_session(token, req.session_id)
    session = store.add_flag(
        req.session_id,
        store.Flag(type=req.type, detail=req.detail, severity=req.severity),
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    await hub.broadcast(_flag_event(session, session.flags[-1]))
    return {"ok": True, "total_flags": len(session.flags)}


@app.post("/api/snapshot")
async def snapshot(
    session_id: str = Form(...),
    image: UploadFile = File(...),
    token: dict = Depends(require_candidate),
):
    _require_own_session(token, session_id)
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session")

    data = await image.read()
    store.set_snapshot(session_id, data)     # keep latest frame for the live proctor view
    detections = await asyncio.to_thread(analyze_snapshot, data)

    for det in detections:
        f = store.Flag(
            type=det["type"], detail=det.get("detail"),
            severity=det.get("severity", "high"),
        )
        session = store.add_flag(session_id, f) or session
        await hub.broadcast(_flag_event(session, f))

    return {"ok": True, "detections": detections}


@app.post("/api/answer")
async def answer(req: AnswerRequest, token: dict = Depends(require_candidate)):
    """Save one question's free-text answer (per-question 'Save' button)."""
    _require_own_session(token, req.session_id)
    if not store.save_answer(req.session_id, req.question_id, req.answer):
        raise HTTPException(status_code=404, detail="Unknown session")
    return {"ok": True,
            "answered": store.count_answers(req.session_id),
            "total": exam_data.question_count()}


@app.post("/api/submit", response_model=SubmitResponse)
async def submit(req: SubmitRequest, token: dict = Depends(require_candidate)):
    _require_own_session(token, req.session_id)
    if store.get_session(req.session_id) is None:
        raise HTTPException(status_code=404, detail="Unknown session")

    # Save-all safety net for any textarea the candidate didn't explicitly save.
    for qid, text in (req.answers or {}).items():
        store.save_answer(req.session_id, qid, text)

    session = store.set_submitted(req.session_id) or store.get_session(req.session_id)
    answered = store.count_answers(req.session_id)
    total = exam_data.question_count()
    await hub.broadcast({
        "kind": "submit", "session_id": session.id,
        "candidate_name": session.candidate_name,
        "answered": answered, "total": total, "flags": len(session.flags),
    })
    return SubmitResponse(answered=answered, total=total, flags=len(session.flags))


@app.post("/api/heartbeat")
async def heartbeat(
    session_id: str = Form(...),
    token: dict = Depends(require_candidate),
):
    """Candidate pings this every few seconds. Absence => 'dropped off'."""
    _require_own_session(token, session_id)
    s = store.touch(session_id)
    return {"ok": s is not None}


# --------------------------------------------------------------------------- #
# Proctor endpoints
# --------------------------------------------------------------------------- #
ONLINE_WINDOW = 12   # seconds without a heartbeat before we call them "dropped"


@app.get("/api/sessions")
async def sessions(_: dict = Depends(require_proctor)):
    now = time.time()
    out = []
    for s in store.all_sessions():
        since_seen = now - s.last_seen
        # Pair leave/return events into drop-off intervals for the timeline.
        dropoffs = [
            {"ts": f.ts, "detail": f.detail, "type": f.type}
            for f in s.flags
            if f.type in ("focus_loss", "tab_switch", "away_return", "fullscreen_exit")
        ]
        out.append({
            "session_id": s.id,
            "candidate_name": s.candidate_name,
            "started_at": s.started_at,
            "submitted": s.submitted,
            "score": s.score,
            "answered": store.count_answers(s.id),
            "total_questions": exam_data.question_count(),
            "last_seen": s.last_seen,
            "seconds_since_seen": round(since_seen, 1),
            "online": since_seen < ONLINE_WINDOW and not s.submitted,
            "has_snapshot": s.last_snapshot is not None,
            "snapshot_age": round(now - s.last_snapshot_ts, 1) if s.last_snapshot_ts else None,
            "dropoffs": dropoffs,
            "flags": [
                {"type": f.type, "detail": f.detail,
                 "severity": f.severity, "ts": f.ts}
                for f in s.flags
            ],
        })
    return out


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, _: dict = Depends(require_proctor)):
    """Proctor: remove a candidate (and their flags, answers, camera frame)."""
    if not store.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Unknown session")
    return {"ok": True}


@app.get("/api/answers/{session_id}")
async def answers_for(session_id: str, _: dict = Depends(require_proctor)):
    """Proctor: read a candidate's saved free-text answers, joined to questions."""
    s = store.get_session(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Unknown session")
    saved = store.get_answers(session_id)
    items = []
    for sec in exam_data.EXAM["sections"]:
        for q in sec["questions"]:
            a = saved.get(q["id"])
            items.append({
                "question_id": q["id"],
                "section": sec["id"],
                "text": q["text"],
                "points": q["points"],
                "answer": a["answer"] if a else "",
                "updated_at": a["updated_at"] if a else None,
            })
    return {"session_id": session_id, "candidate_name": s.candidate_name,
            "submitted": s.submitted, "items": items}


@app.get("/api/snapshot/{session_id}")
async def get_snapshot(session_id: str, token: str | None = None):
    # Loaded via <img src>, which can't set an Authorization header, so the
    # proctor token arrives as a query param and is verified here.
    payload = verify_token(token or "")
    if payload.get("role") != "proctor":
        raise HTTPException(status_code=403, detail="Proctor role required")
    s = store.get_session(session_id)
    if s is None or s.last_snapshot is None:
        raise HTTPException(status_code=404, detail="No frame yet")
    return Response(content=s.last_snapshot, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.websocket("/ws/proctor")
async def ws_proctor(ws: WebSocket, token: str | None = None):
    # WebSockets can't send Authorization headers from the browser, so the
    # proctor token arrives as a query param: /ws/proctor?token=...
    try:
        payload = verify_token(token or "")
        if payload.get("role") != "proctor":
            raise HTTPException(status_code=403, detail="Proctor role required")
    except HTTPException:
        await ws.close(code=1008)   # policy violation
        return

    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()   # keep-alive; we don't expect client msgs
    except WebSocketDisconnect:
        hub.disconnect(ws)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Serve the built frontend (single-origin deploy). Registered LAST so it never
# shadows the API routes above.
# --------------------------------------------------------------------------- #
if config.FRONTEND_DIST and os.path.isdir(config.FRONTEND_DIST):
    _dist = config.FRONTEND_DIST
    _assets = os.path.join(_dist, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        # Never let the SPA fallback answer API/WS paths.
        if full_path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = os.path.join(_dist, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_dist, "index.html"))
