"""ApexTestPortal backend — FastAPI.

Endpoints:
    POST /api/login              -> start a session, get the exam (no answer keys)
    POST /api/flag               -> record a cheating flag; broadcast to proctors
    POST /api/snapshot           -> upload webcam frame; AI-analyze; flag if needed
    POST /api/submit             -> grade the exam
    GET  /api/sessions           -> proctor: list sessions + flags
    WS   /ws/proctor             -> proctor: live stream of flags
"""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import store, exam_data
from .models import (
    LoginRequest, LoginResponse, FlagRequest, SubmitRequest, SubmitResponse,
)
from .proctoring import analyze_snapshot

app = FastAPI(title="ApexTestPortal")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten to your frontend origin in production
    allow_methods=["*"],
    allow_headers=["*"],
)


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


# --------------------------------------------------------------------------- #
# Candidate endpoints
# --------------------------------------------------------------------------- #
@app.post("/api/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    if req.exam_code.strip().upper() != exam_data.EXAM_CODE:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Invalid exam code")
    if not req.name.strip():
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Name required")

    session = store.create_session(req.name.strip(), exam_data.EXAM["id"])
    return LoginResponse(
        session_id=session.id,
        candidate_name=session.candidate_name,
        exam=exam_data.public_exam(),
    )


@app.post("/api/flag")
async def flag(req: FlagRequest):
    session = store.add_flag(
        req.session_id,
        store.Flag(type=req.type, detail=req.detail, severity=req.severity),
    )
    if session is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown session")
    await hub.broadcast(_flag_event(session, session.flags[-1]))
    return {"ok": True, "total_flags": len(session.flags)}


@app.post("/api/snapshot")
async def snapshot(session_id: str = Form(...), image: UploadFile = File(...)):
    session = store.get_session(session_id)
    if session is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown session")

    data = await image.read()
    store.set_snapshot(session_id, data)     # keep latest frame for the live proctor view
    detections = await asyncio.to_thread(analyze_snapshot, data)

    for det in detections:
        f = store.Flag(
            type=det["type"], detail=det.get("detail"),
            severity=det.get("severity", "high"),
        )
        store.add_flag(session_id, f)
        await hub.broadcast(_flag_event(session, f))

    return {"ok": True, "detections": detections}


@app.post("/api/submit", response_model=SubmitResponse)
async def submit(req: SubmitRequest):
    session = store.get_session(req.session_id)
    if session is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Unknown session")

    score, total = exam_data.grade(req.answers)
    session.submitted = True
    session.score = score
    await hub.broadcast({
        "kind": "submit", "session_id": session.id,
        "candidate_name": session.candidate_name,
        "score": score, "total": total, "flags": len(session.flags),
    })
    return SubmitResponse(score=score, total=total, flags=len(session.flags))


@app.post("/api/heartbeat")
async def heartbeat(session_id: str = Form(...)):
    """Candidate pings this every few seconds. Absence => 'dropped off'."""
    s = store.touch(session_id)
    return {"ok": s is not None}


# --------------------------------------------------------------------------- #
# Proctor endpoints
# --------------------------------------------------------------------------- #
ONLINE_WINDOW = 12   # seconds without a heartbeat before we call them "dropped"


@app.get("/api/sessions")
async def sessions():
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


@app.get("/api/snapshot/{session_id}")
async def get_snapshot(session_id: str):
    from fastapi import Response, HTTPException
    s = store.get_session(session_id)
    if s is None or s.last_snapshot is None:
        raise HTTPException(status_code=404, detail="No frame yet")
    return Response(content=s.last_snapshot, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store"})


@app.websocket("/ws/proctor")
async def ws_proctor(ws: WebSocket):
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()   # keep-alive; we don't expect client msgs
    except WebSocketDisconnect:
        hub.disconnect(ws)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
