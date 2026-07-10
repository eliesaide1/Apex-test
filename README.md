# ApexTestPortal

A web-first secure exam / proctoring portal for **internal training** (medium-stakes).
Goal: **deter + detect** cheating, not make it physically impossible.

> A browser cannot truly block OS-level things (screenshots, AnyDesk, exiting the OS).
> This system instead **detects, warns, logs, and flags** those behaviors, plus uses the
> webcam to catch real-world cheating (phone, second person, looking away). If you later
> need true OS lockdown, wrap this same web app in Electron/Tauri kiosk mode — no rewrite.

## Architecture

```
React (Vite) exam client ──HTTP──> FastAPI backend ──> in-memory store (MVP)
   │  fullscreen + focus/tab guards        │
   │  name watermark, key/copy blocks      ├── WebSocket /ws/proctor ─> Proctor dashboard (live flags)
   │  webcam snapshots ────────────────────┘        └── AI analyzer stub (Phase 3: YOLO + MediaPipe)
```

## Build phases

- **Phase 1 (done):** Exam UI, fullscreen enforcement, tab/focus detection, key & copy/paste
  blocking, PrintScreen detection, name watermark, flag logging, live proctor dashboard.
- **Phase 2 (wired):** Webcam capture + periodic snapshot upload to backend.
- **Phase 3 (stub):** Swap the backend `analyze_snapshot` stub for real CV
  (YOLO for phone/second-person, MediaPipe for gaze/face-presence).

## Run it

**Backend** (terminal 1):
```
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows PowerShell:  .venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend** (terminal 2):
```
cd frontend
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173).

- Candidate: log in with any name + the code `DEMO`.
- Proctor: open `/proctor` to watch live flags.

## Next steps

- Replace in-memory store with PostgreSQL + Redis (see `backend/app/store.py`).
- Replace `analyze_snapshot` stub with real YOLO/MediaPipe inference.
- Add real auth (candidates + proctor roles).
- For true lockdown: wrap in Tauri/Electron kiosk + process watchdog.
