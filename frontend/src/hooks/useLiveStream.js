import { useEffect, useState } from "react";
import { candidateWsUrl, fetchRtcConfig } from "../api";

/**
 * Candidate side of the real-time (WebRTC) view.
 *
 * Holds a signalling WebSocket open for the whole exam. It carries no media and
 * no exam data — the server only uses it to tell us "a proctor wants to watch",
 * and to shuttle SDP/ICE between the two browsers. When a proctor starts
 * watching we publish the SAME camera/mic tracks the snapshot pipeline already
 * uses (no second getUserMedia, so no second permission prompt) and the media
 * flows peer-to-peer, never through the server. That is what makes it real time
 * rather than the ~3s snapshot cadence.
 *
 * We only ever send; nothing from the proctor is played back to the candidate,
 * so this cannot be used to talk to them.
 */
export function useLiveStream(sessionId, streamRef, streamReady) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!sessionId || !streamReady) return;

    let ws, pc, closed = false, retry;

    const closePeer = () => {
      if (pc) {
        try { pc.close(); } catch { /* already gone */ }
        pc = null;
      }
      setLive(false);
    };

    const send = (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    async function startPeer() {
      closePeer();
      const stream = streamRef.current;
      if (!stream) return;

      const { iceServers } = await fetchRtcConfig().catch(() => ({ iceServers: [] }));
      pc = new RTCPeerConnection({ iceServers });

      // Send-only: the proctor watches, the candidate hears nothing back.
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      pc.onicecandidate = (e) => {
        if (e.candidate) send({ kind: "rtc-ice", candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        setLive(pc.connectionState === "connected");
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          setLive(false);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ kind: "rtc-offer", sdp: pc.localDescription.sdp,
             type: pc.localDescription.type });
    }

    function connect() {
      ws = new WebSocket(candidateWsUrl());

      ws.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.kind === "rtc-start") {
          startPeer().catch(() => closePeer());
        } else if (msg.kind === "rtc-stop") {
          closePeer();
        } else if (msg.kind === "rtc-answer" && pc) {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
            .catch(() => {});
        } else if (msg.kind === "rtc-ice" && pc && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        }
      };

      // Keep the socket alive through proxies, and reconnect if it drops so a
      // proctor can still start watching later in the exam.
      const ping = setInterval(() => send({ kind: "ping" }), 25000);
      ws.onclose = () => {
        clearInterval(ping);
        closePeer();
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      closePeer();
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [sessionId, streamRef, streamReady]);

  return { live };
}
