// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNALING_SERVER =
  import.meta.env.VITE_SIGNALING_SERVER || window.location.origin;
const socket = io(SIGNALING_SERVER, {
  autoConnect: true,
  transports: ["websocket", "polling"],
});
try {
  window.__SIGNAL_SOCKET = socket;
} catch (e) {}

export default function App() {
  const localAudioRef = useRef();
  const remoteAudioRef = useRef();
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const lastRemoteStreamIdRef = useRef(null);

  const pendingSDPRef = useRef([]);
  const pendingCandidatesRef = useRef([]);
  const pendingDCMessagesRef = useRef([]);

  const localIdRef = useRef(null);
  const currentPartnerRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [msgLog, setMsgLog] = useState([]);
  const [text, setText] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [isInCall, setIsInCall] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [onlineList, setOnlineList] = useState([]);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyList, setHistoryList] = useState([]);
  const [autoActive, setAutoActive] = useState(false);

  // allowIncoming controls whether manual incoming requests are accepted (if false -> auto-reject)
  const [allowIncoming, setAllowIncoming] = useState(true);

  function appendLog(objOrText) {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    let msg;
    if (typeof objOrText === "string") {
      msg = {
        id,
        sender: "system",
        text: objOrText,
        system: true,
        time: Date.now(),
      };
    } else {
      msg = {
        id,
        sender: objOrText.sender ?? "remote",
        text: objOrText.text ?? "",
        time: objOrText.time ?? Date.now(),
        system: objOrText.system ?? false,
        me: objOrText.me ?? false,
      };
    }
    setMsgLog((prev) => [...prev, msg]);
    console.debug("[log]", msg);
  }

  function shortId(id) {
    if (!id) return "anon";
    return id.slice(0, 6);
  }
  function fmtTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString();
  }

  // try play helper (retries) to reduce autoplay issues
  async function tryPlay(el, tries = 4, delay = 250) {
    if (!el) return false;
    try {
      el.volume = 0.8;
    } catch (e) {}
    for (let i = 0; i < tries; i++) {
      try {
        const p = el.play();
        if (!p) {
          appendLog("[audio] play() no-promise");
          return true;
        }
        await p;
        appendLog("[audio] playing");
        return true;
      } catch (err) {
        console.warn(`audio play attempt ${i + 1} failed`, err);
        if (i < tries - 1) await new Promise((r) => setTimeout(r, delay));
        else {
          appendLog("[audio] autoplay blocked");
          return false;
        }
      }
    }
    return false;
  }

  async function trySetSinkId(el) {
    if (!el || !("setSinkId" in HTMLMediaElement.prototype)) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outputs = devs.filter((d) => d.kind === "audiooutput");
      if (outputs.length === 0) return;
      const chosen =
        outputs.find((o) => o.deviceId !== "default") || outputs[0];
      if (chosen && chosen.deviceId) {
        try {
          await el.setSinkId(chosen.deviceId);
          appendLog(`[audio] sink -> ${chosen.label || chosen.deviceId}`);
        } catch (e) {
          console.warn("setSinkId failed", e);
        }
      }
    } catch (e) {
      console.warn("enumerateDevices error", e);
    }
  }

  useEffect(() => {
    socket.on("connect", () => {
      localIdRef.current = socket.id;
      setConnected(true);
      appendLog(`[socket] connected (${shortId(socket.id)})`);
    });

    socket.on("disconnect", () => {
      setConnected(false);
      appendLog("[socket] disconnected");
    });

    socket.on("presence", ({ count, list }) => setOnlineList(list || []));

    socket.on("history", ({ list }) => {
      setHistoryList(list || []);
      setHistoryVisible(true);
    });

    // IMPORTANT: call-invite handling with auto-accept logic
    socket.on("call-invite", async ({ from }) => {
      currentPartnerRef.current = from;
      // if user has disabled incoming requests -> auto-reject
      if (!allowIncoming) {
        socket.emit("call-reject", { to: from, from: localIdRef.current });
        appendLog(`Auto-rejected invite from ${shortId(from)}`);
        return;
      }

      // If current user enabled AUTO, we auto-accept (this implements the chain behaviour you described)
      if (autoActive) {
        appendLog(
          `Auto-accepting invite from ${shortId(from)} (autoActive=true)`
        );
        try {
          // prepare pc and mic BEFORE sending call-accept so audio flows asap
          await createPeerAsCallee();
        } catch (err) {
          appendLog("[Error] Mic access failed for auto-accept");
          socket.emit("call-reject", { to: from, from: localIdRef.current });
          currentPartnerRef.current = null;
          return;
        }
        socket.emit("call-accept", { to: from, from: localIdRef.current });
        // don't show modal
        setIncomingCall(null);
        return;
      }

      // else show incoming modal (manual accept/reject)
      setIncomingCall({ from });
      appendLog(`Incoming call from ${shortId(from)}`);
    });

    // when server asks us to prepare as callee silently (auto pairing)
    socket.on("auto-ready", async ({ from }) => {
      try {
        currentPartnerRef.current = from;
        await createPeerAsCallee();
        appendLog({
          text: `[auto-ready] preparing as callee for ${shortId(from)}`,
          system: true,
        });
        // server will send offer — do not emit accept here (server handles pairing)
      } catch (e) {
        appendLog({
          text: "[auto-ready] failed to get mic / create peer",
          system: true,
        });
        socket.emit("call-reject", { to: from, from: localIdRef.current });
        currentPartnerRef.current = null;
      }
    });

    socket.on("call-accept", ({ from }) => {
      appendLog(`Call accepted by ${shortId(from)}`);
      currentPartnerRef.current = from;
      startOfferFlow(from).catch((e) =>
        console.error("startOfferFlow error", e)
      );
    });

    socket.on("call-reject", ({ from }) => {
      appendLog(`Call rejected by ${shortId(from)}`);
      if (currentPartnerRef.current === from) currentPartnerRef.current = null;
    });

    socket.on("call-hangup", ({ from }) => {
      appendLog(`Call ended by ${shortId(from)}`);
      cleanupCall();
    });

    socket.on("chat", ({ sender, text }) => appendLog({ sender, text }));

    socket.on("signal", async ({ id, data }) => {
      try {
        if (data.sdp) {
          if (data.sdp.type === "offer") {
            if (!pcRef.current) {
              try {
                await createPeerAsCallee();
              } catch (err) {
                appendLog("[Error] mic failed for incoming offer");
                socket.emit("call-reject", {
                  to: id,
                  from: localIdRef.current,
                });
                return;
              }
            }
            if (pcRef.current.signalingState !== "stable") {
              pendingSDPRef.current.push({ sdp: data.sdp, from: id });
              return;
            }
            await pcRef.current.setRemoteDescription(
              new RTCSessionDescription(data.sdp)
            );
            const answer = await pcRef.current.createAnswer();
            await pcRef.current.setLocalDescription(answer);
            socket.emit("signal", { to: id, data: { sdp: answer } });
            await flushPendingCandidatesFor(id);
          } else if (data.sdp.type === "answer") {
            if (!pcRef.current) {
              pendingSDPRef.current.push({ sdp: data.sdp, from: id });
              return;
            }
            const st = pcRef.current.signalingState;
            if (st === "have-local-offer" || st === "have-remote-offer") {
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription(data.sdp)
              );
              await flushPendingCandidatesFor(id);
            } else {
              pendingSDPRef.current.push({ sdp: data.sdp, from: id });
            }
          }
        } else if (data.candidate) {
          if (!pcRef.current || pcRef.current.signalingState === "closed") {
            pendingCandidatesRef.current.push({
              candidate: data.candidate,
              from: id,
            });
            return;
          }
          try {
            await pcRef.current.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } catch (e) {
            console.warn("addIceCandidate failed -> queued", e);
            pendingCandidatesRef.current.push({
              candidate: data.candidate,
              from: id,
            });
          }
        }
      } catch (err) {
        console.error("signal handler error", err);
      }
    });

    socket.on("auto-complete", () => {
      appendLog("Auto-call finished");
      setAutoActive(false);
    });
    socket.on("auto-stopped", () => {
      appendLog("Auto-call stopped");
      setAutoActive(false);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("presence");
      socket.off("history");
      socket.off("call-invite");
      socket.off("call-accept");
      socket.off("call-reject");
      socket.off("call-hangup");
      socket.off("chat");
      socket.off("signal");
      socket.off("auto-complete");
      socket.off("auto-stopped");
      socket.off("auto-ready");
    };
  }, [autoActive, allowIncoming]);

  async function flushPendingCandidatesFor(peerId) {
    const remaining = [];
    for (const item of pendingCandidatesRef.current) {
      if (!item.from || item.from === peerId) {
        try {
          if (pcRef.current && pcRef.current.signalingState !== "closed") {
            await pcRef.current.addIceCandidate(
              new RTCIceCandidate(item.candidate)
            );
          } else remaining.push(item);
        } catch (e) {
          remaining.push(item);
        }
      } else remaining.push(item);
    }
    pendingCandidatesRef.current = remaining;
  }

  // create peer as caller
  async function createPeerAsCaller(targetId) {
    cleanupPeer();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    try {
      const dc = pc.createDataChannel("chat");
      setupDataChannel(dc);
      dcRef.current = dc;
    } catch (e) {
      console.warn("createDataChannel failed", e);
    }

    pc.ondatachannel = (ev) => setupDataChannel(ev.channel);

    pc.ontrack = async (ev) => {
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : null;
      if (!stream) return;
      if (lastRemoteStreamIdRef.current === stream.id) return;
      lastRemoteStreamIdRef.current = stream.id;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 0.8;
        await tryPlay(remoteAudioRef.current);
        await trySetSinkId(remoteAudioRef.current);
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && targetId)
        socket.emit("signal", {
          to: targetId,
          data: { candidate: ev.candidate },
        });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setIsInCall(true);
      if (["failed", "disconnected", "closed"].includes(pc.connectionState))
        cleanupCall();
    };

    // get mic and add tracks
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      localStreamRef.current = stream;
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = stream;
        try {
          localAudioRef.current.muted = true;
        } catch {}
      }
      stream.getTracks().forEach((t) => {
        try {
          pc.addTrack(t, stream);
        } catch (e) {
          console.warn("addTrack caller error", e);
        }
      });
      appendLog("[mic] local capture ready (caller)");
    } catch (err) {
      appendLog("[Error] Microphone not available (caller)");
      console.error(err);
    }

    return pc;
  }

  // create peer as callee (get mic BEFORE returning)
  async function createPeerAsCallee() {
    cleanupPeer();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    pc.ondatachannel = (ev) => setupDataChannel(ev.channel);

    pc.ontrack = async (ev) => {
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : null;
      if (!stream) return;
      if (lastRemoteStreamIdRef.current === stream.id) return;
      lastRemoteStreamIdRef.current = stream.id;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 0.8;
        await tryPlay(remoteAudioRef.current);
        await trySetSinkId(remoteAudioRef.current);
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && currentPartnerRef.current)
        socket.emit("signal", {
          to: currentPartnerRef.current,
          data: { candidate: ev.candidate },
        });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setIsInCall(true);
      if (["failed", "disconnected", "closed"].includes(pc.connectionState))
        cleanupCall();
    };

    // getUserMedia BEFORE returning
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      localStreamRef.current = stream;
      if (localAudioRef.current) {
        localAudioRef.current.srcObject = stream;
        try {
          localAudioRef.current.muted = true;
        } catch {}
      }
      stream.getTracks().forEach((t) => {
        try {
          pc.addTrack(t, stream);
        } catch (e) {
          console.warn("addTrack callee error", e);
        }
      });
      appendLog("[mic] local capture ready (callee)");
    } catch (err) {
      appendLog("[Error] Microphone access denied/unavailable (callee)");
      throw err;
    }

    return pc;
  }

  function cleanupPeer() {
    try {
      if (dcRef.current) {
        try {
          dcRef.current.close();
        } catch {}
        dcRef.current = null;
      }
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {}
        pcRef.current = null;
      }
    } catch (e) {
      console.warn(e);
    }
  }

  function cleanupCall() {
    setIsInCall(false);
    setIncomingCall(null);
    setIsMuted(false);
    currentPartnerRef.current = null;
    lastRemoteStreamIdRef.current = null;

    if (localStreamRef.current) {
      try {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      localStreamRef.current = null;
      if (localAudioRef.current) localAudioRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    cleanupPeer();
    pendingSDPRef.current = [];
    pendingCandidatesRef.current = [];
    pendingDCMessagesRef.current = [];
  }

  function setupDataChannel(dc) {
    dcRef.current = dc;
    dc.onopen = () => {
      appendLog("[DataChannel] open");
      while (pendingDCMessagesRef.current.length) {
        const m = pendingDCMessagesRef.current.shift();
        try {
          dcRef.current.send(JSON.stringify(m));
        } catch (e) {
          socket.emit("chat", {
            to: currentPartnerRef.current,
            sender: localIdRef.current,
            text: m.text || "",
          });
        }
      }
    };
    dc.onclose = () => appendLog("[DataChannel] closed");
    dc.onerror = (e) => appendLog("[DataChannel] error");
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "chat")
            appendLog({ sender: msg.sender, text: msg.text });
          else appendLog({ text: ev.data });
        } catch (e) {
          appendLog({ text: ev.data });
        }
      }
    };
  }

  // UI actions
  function inviteCall(targetId) {
    if (!targetId) return;
    appendLog(`Calling ${shortId(targetId)}...`);
    currentPartnerRef.current = targetId;
    socket.emit("call-invite", { to: targetId, from: localIdRef.current });
  }

  async function acceptIncoming() {
    if (!incomingCall) return;
    const from = incomingCall.from;
    try {
      currentPartnerRef.current = from;
      await createPeerAsCallee(); // ensure mic ready before accept
    } catch (err) {
      appendLog("[Error] Could not access microphone on accept");
      socket.emit("call-reject", { to: from, from: localIdRef.current });
      setIncomingCall(null);
      currentPartnerRef.current = null;
      return;
    }
    socket.emit("call-accept", { to: from, from: localIdRef.current });
    setIncomingCall(null);
    try {
      if (window.__AUDIO_CTX && window.__AUDIO_CTX.state === "suspended")
        await window.__AUDIO_CTX.resume();
      if (remoteAudioRef.current) tryPlay(remoteAudioRef.current);
    } catch (e) {}
  }

  function rejectIncoming() {
    if (!incomingCall) return;
    socket.emit("call-reject", {
      to: incomingCall.from,
      from: localIdRef.current,
    });
    appendLog(`Rejected call from ${shortId(incomingCall.from)}`);
    setIncomingCall(null);
    currentPartnerRef.current = null;
  }

  async function startOfferFlow(targetId) {
    if (!targetId) return;
    currentPartnerRef.current = targetId;
    const pc = await createPeerAsCaller(targetId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: targetId, data: { sdp: offer } });
  }

  function hangup() {
    const partner = currentPartnerRef.current;
    if (partner)
      socket.emit("call-hangup", { from: localIdRef.current, to: partner });
    else socket.emit("call-hangup", { from: localIdRef.current, to: null });
    cleanupCall();
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const tracks = localStreamRef.current.getAudioTracks();
    if (!tracks.length) return;
    const newMuted = !isMuted;
    tracks.forEach((t) => (t.enabled = !newMuted));
    setIsMuted(newMuted);
    appendLog(newMuted ? "[Muted]" : "[Unmuted]");
  }

  function sendChat() {
    const payload = { type: "chat", sender: localIdRef.current, text };
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify(payload));
        appendLog({ sender: localIdRef.current, text, me: true });
        setText("");
        return;
      } catch (e) {
        console.warn("DC send failed", e);
      }
    }
    if (currentPartnerRef.current)
      socket.emit("chat", {
        to: currentPartnerRef.current,
        sender: localIdRef.current ?? "Me",
        text,
      });
    else
      socket.emit("chat", {
        room: null,
        sender: localIdRef.current ?? "Me",
        text,
      });
    appendLog({ sender: localIdRef.current ?? "Me", text, me: true });
    setText("");
  }

  async function startAutoCall() {
    socket.emit("auto-call-start", { initiator: localIdRef.current });
    setAutoActive(true);
    appendLog("[Auto-call] started");
  }
  function stopAutoCall() {
    socket.emit("auto-call-stop", { initiator: localIdRef.current });
    setAutoActive(false);
    appendLog("[Auto-call] stopped");
  }

  function requestHistory() {
    socket.emit("get-history");
  }

  function enableAudioPlayback() {
    try {
      if (remoteAudioRef.current) {
        const p = remoteAudioRef.current.play();
        if (p && p.then) p.catch(() => {});
      }
      if (localAudioRef.current) {
        const p2 = localAudioRef.current.play();
        if (p2 && p2.then) p2.catch(() => {});
      }
      if (window.__AUDIO_CTX && window.__AUDIO_CTX.state === "suspended")
        window.__AUDIO_CTX.resume().catch(() => {});
      appendLog("[Action] enableAudioPlayback called");
    } catch (e) {
      console.warn(e);
    }
  }

  // UI
  return (
    <div
      style={{
        padding: 18,
        fontFamily: "Inter, system-ui, sans-serif",
        maxWidth: 1000,
        margin: "0 auto",
      }}
    >
      <style>{`.panel{background:#fff;border:1px solid #e6eef6;padding:12px;border-radius:10px}.btn{padding:6px 10px;border-radius:10px;border:0;background:#0ea5e9;color:white;cursor:pointer}.btn-ghost{background:transparent;border:1px solid #cbd5e1;color:#0f172a}`}</style>

      <h2>WebRTC — Presence & Auto-Call</h2>
      <div>Status: {connected ? "Signaling connected" : "Disconnected"}</div>

      <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
        <div style={{ flex: 1 }} className="panel">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <div>Online: {onlineList.length}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost" onClick={requestHistory}>
                History
              </button>
              {autoActive ? (
                <button className="btn-ghost" onClick={stopAutoCall}>
                  Stop Auto
                </button>
              ) : (
                <button className="btn" onClick={startAutoCall}>
                  Start Auto-Call
                </button>
              )}
            </div>
          </div>
          <div
            style={{ border: "1px solid #eef2ff", padding: 8, borderRadius: 8 }}
          >
            <div style={{ color: "#94a3b8" }}>
              Auto-call: when ON you will auto-accept incoming invites and be
              placed in auto queues to call others automatically.
            </div>
            <div style={{ marginTop: 8 }}>
              <label>
                <input
                  type="checkbox"
                  checked={allowIncoming}
                  onChange={(e) => setAllowIncoming(e.target.checked)}
                />{" "}
                Allow Incoming Requests (if OFF, invites are auto-rejected)
              </label>
            </div>
          </div>
        </div>

        <div style={{ width: 420 }} className="panel">
          <div style={{ marginBottom: 8 }}>Chat / Logs</div>
          <div
            id="log"
            style={{
              maxHeight: 260,
              overflow: "auto",
              padding: 8,
              border: "1px solid #e6eef6",
              borderRadius: 8,
            }}
          >
            {msgLog.map((m) =>
              m.system ? (
                <div
                  key={m.id}
                  style={{
                    textAlign: "center",
                    color: "#64748b",
                    fontSize: 12,
                  }}
                >
                  {m.text}
                </div>
              ) : (
                <div key={m.id} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "#64748b" }}>
                    {shortId(m.sender)}
                  </div>
                  <div
                    style={{
                      background: m.me ? "#0ea5e9" : "#f1f5f9",
                      color: m.me ? "white" : "#0f172a",
                      padding: 8,
                      borderRadius: 8,
                      display: "inline-block",
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              )
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              style={{ flex: 1, padding: 8 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type message..."
            />
            <button className="btn" onClick={sendChat}>
              Send
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }} className="panel">
        <div>Local / Remote Audio</div>
        <audio
          ref={localAudioRef}
          autoPlay
          muted
          playsInline
          style={{ width: "100%", display: "none" }}
        />
        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          style={{ width: "100%" }}
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button className="btn-ghost" onClick={toggleMute}>
            {isMuted ? "Unmute" : "Mute"}
          </button>
          <button className="btn-ghost" onClick={hangup}>
            Hang up
          </button>
          <button
            className="btn-ghost"
            onClick={() =>
              alert("My ID: " + (localIdRef.current || "not connected"))
            }
          >
            My ID
          </button>
          <button className="btn-ghost" onClick={enableAudioPlayback}>
            Enable Audio
          </button>
        </div>
        <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
          Use headphones/earpiece to reduce echo. If audio is delayed, press
          Enable Audio once.
        </div>
      </div>

      {historyVisible && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 360,
              background: "#201744",
              color: "white",
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h3 style={{ margin: 0 }}>Call History</h3>
              <button
                className="btn-ghost"
                onClick={() => setHistoryVisible(false)}
              >
                ✕
              </button>
            </div>
            <div style={{ maxHeight: "50vh", overflow: "auto" }}>
              {historyList.length === 0 ? (
                <div style={{ color: "#9ca3af" }}>No call history yet.</div>
              ) : (
                historyList.map((h) => (
                  <div
                    key={h.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: 8,
                      borderBottom: "1px solid #111",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {shortId(h.id)}{" "}
                        {h.online ? (
                          <small style={{ color: "#34d399" }}>(online)</small>
                        ) : (
                          <small style={{ color: "#9ca3af" }}>(offline)</small>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "#c7d2fe" }}>
                        {h.country || "Unknown"}
                      </div>
                      <div style={{ fontSize: 11, color: "#a5b4fc" }}>
                        {fmtTime(h.last)}
                      </div>
                    </div>
                    <div>
                      <button
                        className="btn"
                        onClick={() => inviteCall(h.id)}
                        disabled={!h.online}
                      >
                        Call
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: 12,
              }}
            >
              <button
                className="btn-ghost"
                onClick={() => setHistoryVisible(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {incomingCall && allowIncoming && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#fff",
              padding: 20,
              borderRadius: 12,
              width: 380,
            }}
          >
            <h3>Incoming call</h3>
            <p>From: {shortId(incomingCall.from)}</p>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button className="btn-ghost" onClick={rejectIncoming}>
                Reject
              </button>
              <button className="btn" onClick={acceptIncoming}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
