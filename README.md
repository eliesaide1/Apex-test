# ApexTestPortal

A web-first secure exam / proctoring portal for **internal training** (medium-stakes).
Goal: **deter + detect** cheating, not make it physically impossible.

> A browser cannot truly block OS-level things (screenshots, AnyDesk, exiting the OS).
> This system instead **detects, warns, logs, and flags** those behaviors, plus uses the
> webcam to catch real-world cheating (phone, second person, looking away). If you later
> need true OS lockdown, wrap this same web app in Electron/Tauri kiosk mode — no rewrite.

## Architecture

```
React (Vite) SPA ──HTTP/JSON──> FastAPI backend ──> SQLite (sessions + flags)
   │  fullscreen + focus/tab guards        │           latest webcam frame kept in-memory
   │  name watermark, key/copy blocks       ├── WebSocket /ws/proctor ─> Proctor dashboard (live flags)
   │  webcam snapshots ─────────────────────┤        ├── analyze_snapshot() stub (Phase 3: YOLO + MediaPipe)
   │  microphone clips ─────────────────────┘        └── analyze_audio() — flags sustained talking
```

In production the backend also **serves the built frontend**, so the whole app is a
single HTTPS origin (no CORS, no hardcoded backend URL, webcam works).

## Auth model

- **Candidate:** logs in with a name + shared **exam code**. Login returns a bearer
  token scoped to that one session — a candidate can only flag/submit **their own** exam.
- **Proctor:** signs in with a **proctor password** to reach the dashboard. The session
  list, live webcam frames, and the proctor WebSocket all require a proctor token.

Tokens are HMAC-signed with `SECRET_KEY` (no external JWT dependency).

## Live audio monitoring

The proctor can **hear** each candidate, which is what catches someone reading
the questions aloud to them or coaching them from off-camera.

**How it works.** The candidate's browser records the microphone as a chain of
short (~4s) *self-contained* clips and uploads each one to `POST /api/audio`.
The proctor's **Listen** button just plays those clips back-to-back as a queue,
so audio runs roughly one clip behind real time. That is deliberate: it needs no
WebRTC, no signalling server and no STUN/TURN, and it reuses the same request
path as the webcam snapshots. Clips live in a small in-memory ring buffer
(`AUDIO_CLIP_KEEP`, default 10 ≈ 40s) and are **never written to disk**.

One candidate is audible at a time — overlapping mics are unusable, and it keeps
the dashboard to a single clip stream. Every card also shows a **live mic level
bar**, so a proctor can see who is talking without listening to each in turn.

**Automatic talking detection.** The browser measures each clip's loudness and
sends it with the upload, so the backend never decodes audio. A clip counts as
speech when it beats a threshold that **adapts to that candidate's own room**:

- the first `VOICE_CALIBRATE_CLIPS` clips learn the room's noise floor (no flags
  are raised during this window)
- afterwards the bar is `max(VOICE_ABS_MIN, floor × VOICE_RATIO)`
- the floor only learns from clips that were *not* speech, so talking non-stop
  can't quietly raise your own bar; `VOICE_FLOOR_MAX` caps what can be learned
- `VOICE_MIN_CLIPS` consecutive speech clips raise **one** `voice_detected`
  flag, then `VOICE_COOLDOWN` suppresses repeats for that episode

Verified against silent rooms, fan noise, typing bursts, isolated coughs, and
talking that starts either mid-exam or from the very first clip.

The capture deliberately sets `echoCancellation`, `noiseSuppression` and
`autoGainControl` to **false**. Those defaults are right for a phone call and
wrong here: AGC winds the level down during sustained speech (measured: a steady
0.16 signal decayed to 0.06), and noise suppression can scrub out exactly the
quiet second voice you want to catch.

**Limits.** This detects *that* someone is talking, not *who*. The proctor
confirms by listening. Real speaker diarization would be the next step — see the
note at the bottom of `proctoring.py`.

## Build phases

- **Phase 1 (done):** Exam UI, fullscreen enforcement, tab/focus detection, key & copy/paste
  blocking, PrintScreen detection, name watermark, flag logging, live proctor dashboard.
- **Phase 2 (done):** Webcam capture + periodic snapshot upload to backend.
- **Phase 2b (done):** Microphone capture, proctor listen-in, and adaptive
  talking detection (`analyze_audio`).
- **Phase 3 (stub):** Swap the backend `analyze_snapshot` stub for real CV
  (YOLO for phone/second-person, MediaPipe for gaze/face-presence). Optionally
  add speaker diarization so `analyze_audio` can name a *second speaker*.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | `dev-insecure-change-me` | Signs auth tokens. **Set a long random value in production.** |
| `PROCTOR_PASSWORD` | `proctor` | Password proctors type to reach the dashboard. |
| `EXAM_CODE` | `DEMO` | Code candidates enter to start the exam. |
| `DB_PATH` | `data/apex.db` | SQLite file location. Point at a mounted disk in production. |
| `FRONTEND_DIST` | *(unset)* | Path to the built frontend (`dist`). Set to serve the SPA from the backend. |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS origins. Only needed for split-origin dev. |
| `AUDIO_CLIP_KEEP` | `10` | Mic clips buffered per candidate (~4s each, in memory only). |
| `VOICE_ABS_MIN` | `0.045` | Loudness floor below which nothing is ever treated as talking. |
| `VOICE_RATIO` | `3.0` | How far above the room's noise floor a clip must be to count as talking. |
| `VOICE_CALIBRATE_CLIPS` | `3` | Opening clips used to learn the room baseline (no flags raised). |
| `VOICE_FLOOR_MAX` | `0.05` | Ceiling on the learned noise floor. |
| `VOICE_MIN_CLIPS` | `2` | Consecutive speech clips before a `voice_detected` flag. |
| `VOICE_COOLDOWN` | `45` | Seconds before the same candidate can be flagged for talking again. |

## Run it locally

### Option A — two processes (fast dev, hot reload)

**Backend** (terminal 1):
```
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1        # Windows PowerShell
pip install -r requirements.txt
$env:ALLOWED_ORIGINS="http://localhost:5173"   # let the Vite dev server call the API
uvicorn app.main:app --reload --port 8000
```

**Frontend** (terminal 2):
```
cd frontend
npm install
$env:VITE_API_BASE="http://localhost:8000"     # point the SPA at the backend
npm run dev
```

Open the printed URL (default http://localhost:5173).

### Option B — single origin (mirrors production)

```
cd frontend && npm install && npm run build      # produces frontend/dist
cd ../backend
pip install -r requirements.txt
$env:FRONTEND_DIST="../frontend/dist"
uvicorn app.main:app --port 8000
```

Open http://localhost:8000.

- **Candidate:** log in with any name + the code `DEMO`.
- **Proctor:** open `/proctor`, sign in with the password `proctor` (the default), to watch live flags.

## Deploy (managed platform — HTTPS out of the box)

The webcam and fullscreen APIs require HTTPS on any non-localhost host, so deploy
somewhere that gives you TLS automatically. A `Dockerfile` (multi-stage: build the
frontend, then run the backend serving it) and a Render blueprint are included.

**Render.com:**
1. Push this repo to GitHub.
2. In Render: **New +** → **Blueprint**, point it at the repo (uses `render.yaml`).
3. Set `PROCTOR_PASSWORD` (and optionally `EXAM_CODE`) in the dashboard. `SECRET_KEY`
   is generated automatically; the SQLite DB persists on the mounted disk at `/var/data`.
4. Open the service URL. Candidates use `/`, proctors use `/proctor`.

Any Docker host works the same way — build the image and run it, providing the env
vars above and a persistent volume mounted at `DB_PATH`, behind an HTTPS proxy.

## Next steps

- Replace `analyze_snapshot` stub with real YOLO/MediaPipe inference (same return shape).
- Move to PostgreSQL + Redis only if you need multiple backend workers (`store.py` is the seam).
- Per-candidate accounts instead of a shared exam code, if you need stronger identity.
- For true lockdown: wrap in Tauri/Electron kiosk + process watchdog.
