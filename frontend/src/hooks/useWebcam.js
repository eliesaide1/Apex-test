import { useEffect, useRef, useState } from "react";
import { sendSnapshot, sendAudio } from "../api";

/** Length of each self-contained microphone clip, in ms. */
const CLIP_MS = 4000;

/** First MediaRecorder container the browser actually supports. */
function pickAudioMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus",
                 "audio/mp4"];
  if (typeof MediaRecorder === "undefined") return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

/**
 * Request the webcam AND microphone, show a live video preview, upload a JPEG
 * snapshot every `intervalMs`, and upload short microphone clips continuously.
 *
 * Both devices are REQUIRED. We monitor each track's liveness so the exam can
 * hide the questions the moment the camera or mic is turned off, and reveal them
 * again once both are back. Reliable "off" signals: permission revoked, device
 * unplugged, or track stopped/muted. (A browser cannot always detect an OS-level
 * soft-mute for privacy reasons — that's a platform limitation.)
 *
 * Audio is recorded as a chain of short, self-contained clips rather than one
 * continuous stream: each clip plays on its own, so the proctor's listen-in is
 * just a play queue — no WebRTC, no signalling server, no TURN. Every clip
 * carries the loudness we measured locally, which is what the backend uses to
 * flag sustained talking.
 *
 * Returns:
 *   videoRef, canvasRef  — attach to <video>/<canvas>
 *   camStatus, micStatus — "idle" | "live" | "denied" | "error" | "off"
 *   camOn, micOn         — booleans for gating
 *   micLevel             — 0..1 live loudness, for the candidate's own meter
 */
export function useWebcam(sessionId, { intervalMs = 3000 } = {}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [camStatus, setCamStatus] = useState("idle");
  const [micStatus, setMicStatus] = useState("idle");
  const [micLevel, setMicLevel] = useState(0);
  // The live (WebRTC) view needs these same tracks — see useLiveStream. Kept in
  // a ref so handing it out never re-runs this effect and re-prompts for
  // permission; `streamReady` is the state flag dependents can watch.
  const streamRef = useRef(null);
  const [streamReady, setStreamReady] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let stream, timer, poll, cancelled = false;
    let audioCtx, levelTimer, stopClips;

    // Liveness is based on readyState only. We deliberately ignore the transient
    // `muted` flag: browsers toggle it on silence / tab-blur, which caused the
    // mic to flap off/on every few seconds. A device being disabled, unplugged,
    // or its permission revoked ends the track (readyState !== "live"), which we
    // DO catch. (OS-level soft-mute isn't reliably detectable — platform limit.)
    const trackLive = (t) => !!t && t.readyState === "live";

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
          // Capture the room as it actually sounds. Chrome enables noise
          // suppression and automatic gain control by default, which is right
          // for a call and wrong for proctoring: AGC winds the level down
          // during sustained speech, and noise suppression can scrub out the
          // quiet second voice we most want to catch. Measured on a fake
          // device, defaults dragged a steady 0.15 signal down to 0.06.
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        streamRef.current = stream;
        setStreamReady(true);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const vTrack = stream.getVideoTracks()[0];
        const aTrack = stream.getAudioTracks()[0];

        const sync = () => {
          setCamStatus(trackLive(vTrack) ? "live" : "off");
          setMicStatus(trackLive(aTrack) ? "live" : "off");
        };
        sync();

        // React to a track actually ending (device disabled / unplugged / revoked).
        [vTrack, aTrack].forEach((t) => t && t.addEventListener("ended", sync));
        // Poll as a backstop in case "ended" doesn't fire.
        poll = setInterval(sync, 1500);

        timer = setInterval(capture, intervalMs);
        if (aTrack) startAudio(aTrack);
      } catch (e) {
        const denied = e && e.name === "NotAllowedError";
        setCamStatus(denied ? "denied" : "error");
        setMicStatus(denied ? "denied" : "error");
      }
    })();

    function capture() {
      const v = videoRef.current, c = canvasRef.current;
      if (!v || !c || v.videoWidth === 0) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((blob) => blob && sendSnapshot(sessionId, blob), "image/jpeg", 0.7);
    }

    // --- microphone: loudness meter + rolling clip upload -------------------- //
    function startAudio(aTrack) {
      const audioStream = new MediaStream([aTrack]);
      let sum = 0, n = 0;   // running mean loudness for the clip being recorded

      // Measure loudness ourselves rather than server-side: it costs nothing
      // here, and it means the backend never has to decode audio to know
      // whether anyone is talking.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        audioCtx.resume?.().catch(() => {});
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        audioCtx.createMediaStreamSource(audioStream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        levelTimer = setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sq += v * v;
          }
          const rms = Math.sqrt(sq / buf.length);
          sum += rms; n += 1;
          setMicLevel(rms);
        }, 100);
      } catch { /* no meter — clips still upload, just with level 0 */ }

      const mime = pickAudioMime();
      if (!mime) return;   // browser can't record; camera proctoring still works

      let stopped = false;
      stopClips = () => { stopped = true; };

      // Each clip is recorded by its own MediaRecorder and the next one starts
      // from `onstop`, so clips never overlap and every blob is independently
      // playable. Chaining (rather than a fixed interval) also stops the queue
      // drifting if a recorder takes longer than CLIP_MS to finalise.
      const recordOne = () => {
        if (stopped || cancelled) return;
        if (aTrack.readyState !== "live") {   // mic off — retry shortly
          setTimeout(recordOne, 1000);
          return;
        }
        let rec;
        try {
          rec = new MediaRecorder(audioStream, { mimeType: mime,
                                                 audioBitsPerSecond: 24000 });
        } catch {
          return;
        }
        const parts = [];
        const startedAt = Date.now();
        sum = 0; n = 0;
        rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
        rec.onstop = () => {
          const blob = new Blob(parts, { type: rec.mimeType || mime });
          if (blob.size && !stopped && !cancelled) {
            sendAudio(sessionId, blob, n ? sum / n : 0, Date.now() - startedAt);
          }
          recordOne();
        };
        try { rec.start(); } catch { return; }
        setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, CLIP_MS);
      };
      recordOne();
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(poll);
      clearInterval(levelTimer);
      stopClips?.();
      audioCtx?.close?.().catch(() => {});
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStreamReady(false);
    };
  }, [sessionId, intervalMs]);

  const camOn = camStatus === "live";
  const micOn = micStatus === "live";
  return { videoRef, canvasRef, camStatus, micStatus, camOn, micOn, micLevel,
           streamRef, streamReady };
}
