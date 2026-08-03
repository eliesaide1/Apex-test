"""Webcam snapshot + microphone analysis.

`analyze_snapshot` is a PHASE 3 STUB — it returns no detections so the app runs
with zero ML dependencies. Replace it with real inference:

    - Object detection (phone, book, second person): YOLOv8/YOLOv11 (ultralytics)
    - Face presence + gaze direction ("looking away"): MediaPipe FaceMesh

`analyze_audio` is NOT a stub. It works today on the loudness level the browser
measures for each clip, because in a written exam any sustained talking is worth
a look — a candidate has no reason to speak, so someone reading the questions to
them (or coaching them) shows up as speech. It cannot tell *who* is talking; the
proctor confirms that by listening to the clip. See the note at the bottom for
what real ML would add here.

Return the same shape from either and the dashboard / flag pipeline keeps
working unchanged.
"""
from __future__ import annotations

from . import config


def analyze_snapshot(image_bytes: bytes) -> list[dict]:
    """Return a list of detections, e.g.:

        [{"type": "phone_detected", "severity": "high", "detail": "conf 0.91"}]

    Stub returns [] (nothing detected). Wire real CV here.
    """
    # --- Example of the real implementation (pseudo) ---
    # results = yolo_model(image)  # ultralytics
    # dets = []
    # for box in results.boxes:
    #     label = yolo_model.names[int(box.cls)]
    #     if label == "cell phone":
    #         dets.append({"type": "phone_detected", "severity": "high",
    #                      "detail": f"conf {float(box.conf):.2f}"})
    #     if label == "person" and person_count > 1:
    #         dets.append({"type": "second_person", "severity": "high"})
    # return dets
    return []


def speech_threshold(floor: float | None) -> float:
    """Loudness a clip must exceed to count as talking, given the room's noise
    floor. Absolute mic levels vary by an order of magnitude between machines,
    so the bar scales with whatever this candidate's quiet baseline turned out
    to be, never dropping below VOICE_ABS_MIN."""
    if floor is None:
        return config.VOICE_ABS_MIN
    return max(config.VOICE_ABS_MIN, floor * config.VOICE_RATIO)


def analyze_audio(clip_bytes: bytes, level: float, sustained: bool) -> list[dict]:
    """Return detections for one audio clip.

    `level` is the 0..1 loudness the browser measured. `sustained` is True only
    once per talking episode (the store tracks the consecutive-clip run and the
    cooldown), so this raises one flag per episode, not one per clip.
    """
    if not sustained:
        return []
    return [{
        "type": "voice_detected",
        "severity": "high",
        "detail": f"Sustained talking heard (level {level:.2f}) — listen to confirm",
    }]

    # --- What real audio ML would add (same return shape) ---
    # Speaker diarization (pyannote.audio / SpeechBrain) to separate voices and
    # count distinct speakers -> "second_speaker" when someone other than the
    # enrolled candidate talks. Whisper/faster-whisper on the clip would let you
    # flag exam question text being read aloud. Both are heavy GPU-side models,
    # so run them off the request path (a queue) rather than in analyze_audio.
