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
   │
   └─ WebRTC <══════════════════════════════════════════> Proctor dashboard
      real-time video + audio, PEER-TO-PEER (never touches the server).
      Candidate -> proctor: always, while watched.
      Proctor -> candidate: voice only while push-to-talk is HELD.
      The server only relays SDP/ICE: /ws/candidate <-> /ws/proctor.
```

In production the backend also **serves the built frontend**, so the whole app is a
single HTTPS origin (no CORS, no hardcoded backend URL, webcam works).

## Auth model

- **Candidate:** logs in with a name + shared **exam code**. Login returns a bearer
  token scoped to that one session — a candidate can only flag/submit **their own** exam.
- **Proctor:** signs in with a **proctor password** to reach the dashboard. The session
  list, live webcam frames, and the proctor WebSocket all require a proctor token.

Tokens are HMAC-signed with `SECRET_KEY` (no external JWT dependency).

## Live monitoring — two layers

The dashboard runs two independent paths, and it matters which is which.

### 1. Real-time view (WebRTC) — one candidate at a time

Click a candidate's camera tile (or **Listen** for audio only) and you get
**sub-second video and audio**. Media flows **peer-to-peer** straight from the
candidate's browser to yours; it never passes through this server. The server
only relays the SDP offer/answer and ICE candidates over the WebSockets that
already exist (`/ws/candidate` ↔ `/ws/proctor`).

Measured on loopback: connection up in ~1s, 20fps, zero packet loss, 7ms video
and 32ms audio jitter buffer. On a real network add the round-trip time, so
expect well under 200ms. Compare the snapshot layer below, measured on the same
candidate at the same moment: **2.9s** stale video, **1.8s** audio.

Only one candidate streams at a time — each live view costs that candidate an
upstream video stream, and overlapping mics are unusable. The enlarged view and
the Listen button share a single peer connection.

**Talking back — push-to-talk.** Audio is deliberately asymmetric. The
candidate's mic is up the whole time you are watching them; yours is not.
**Hold** 🎙 *Hold to talk* (in the enlarged view or the header chip) and the
candidate hears you for exactly as long as the button is down. Release it and
they hear nothing. The candidate has no equivalent control and cannot initiate
audio — they can only be spoken to.

That guarantee is structural, not cosmetic. Until you press, the proctor→
candidate direction carries **no track at all**: answering the offer reserves
the direction in SDP, and the mic is attached later with `replaceTrack()`, so
there is nothing to leak. Releasing disables the track, which transmits digital
silence. Measured end-to-end on the candidate's own audio element: RMS `0.0000`
before the press, `0.0322` while held, `0.0000` after release. Only the proctor
**currently watching** that candidate may talk into their room — a second
signed-in proctor's `rtc-talk` is dropped by the server.

Two consequences worth knowing:

- **It is half-duplex, like a radio.** While you hold the button the
  candidate's incoming audio is muted, because their capture runs with echo
  cancellation off (see below) and you would otherwise hear yourself returned a
  beat late off their speakers.
- **It cannot make the candidate's own talking detection fire.** Clips the
  candidate records while you are speaking arrive marked `suppress`; the
  backend keeps them for listen-in but takes no verdict from them and does not
  let them train the room's noise floor. Without this, talking to a candidate
  would flag that candidate for talking.

The candidate sees a green *"Your proctor is speaking to you"* banner while you
hold, so the voice is never disembodied. Push-to-talk needs the live view open —
it rides the same peer connection — so it is not a way to reach a candidate you
are not watching. For that, use ✉ **Message** (text, must be acknowledged).

**NAT traversal.** STUN alone (the default) covers most home and office
networks. It is *not* enough behind symmetric NAT or strict corporate
firewalls; those need a TURN relay. Set `TURN_URL` / `TURN_USERNAME` /
`TURN_CREDENTIAL` (Twilio, Cloudflare, Metered, or your own coturn) to cover
them. Without TURN those candidates simply fall back to the snapshot view and
the modal says *peer connection failed* — you are never silently shown a frozen
picture.

### 2. Always-on layer (snapshots + audio clips) — every candidate

This is the older path and it deliberately stays: it runs for **all** candidates
simultaneously, which a mesh of WebRTC streams could not. It feeds the card
thumbnails (~3s), the mic level bars, and the automatic talking detection, and
it is the fallback whenever a peer connection cannot be established.

The candidate's browser records the microphone as a chain of short (~4s)
*self-contained* clips and uploads each to `POST /api/audio`. Clips live in an
in-memory ring buffer (`AUDIO_CLIP_KEEP`, default 10 ≈ 40s) and are **never
written to disk**. Snapshots work the same way — latest frame only, in memory.

Both layers run at once: opening a live view does not interrupt flag detection.

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
- **Phase 2c (done):** Real-time peer-to-peer video + audio (WebRTC) for the
  candidate a proctor is actively watching, plus proctor push-to-talk back.
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
| `STUN_URLS` | Google STUN | Comma-separated STUN servers for the real-time view. |
| `TURN_URL` | *(unset)* | TURN relay, needed for candidates behind symmetric NAT / strict firewalls. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | *(unset)* | Credentials for that TURN server. |

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
