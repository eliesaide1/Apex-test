"""Webcam snapshot analysis.

PHASE 3 STUB. Today this returns no detections so the app runs with zero ML
dependencies. Replace `analyze_snapshot` with real inference:

    - Object detection (phone, book, second person): YOLOv8/YOLOv11 (ultralytics)
    - Face presence + gaze direction ("looking away"): MediaPipe FaceMesh

Return the same shape and the dashboard / flag pipeline keeps working unchanged.
"""
from __future__ import annotations


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
