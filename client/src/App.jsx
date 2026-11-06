// client/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone,
  PhoneDisconnect,
  Microphone,
  MicrophoneSlash,
  Users,
  Clock,
  ClockCounterClockwise,
  Chat,
  WifiHigh,
  WifiNone,
  Circle,
  ArrowRight,
  Star,
  SpeakerHigh,
  SpeakerNone,
  XCircle,
  X,
} from "@phosphor-icons/react";

const SIGNALING_SERVER = import.meta.env.VITE_SIGNALING_SERVER || "http://localhost:3000";
const socket = io(SIGNALING_SERVER, {
  autoConnect: true,
  transports: ["websocket", "polling"],
});
try {
  window.__SIGNAL_SOCKET = socket;
} catch (e) {}

// Audio Visualizer Component
const AudioVisualizer = ({ isSpeaking, isActive }) => {
  return (
    <div className="visualizer-container">
      {[...Array(5)].map((_, i) => (
        <motion.div
          key={i}
          className="visualizer-bar"
          animate={{
            height: isSpeaking ? [8, 24 + Math.random() * 16, 8] : 8,
            opacity: isActive ? 0.8 : 0.4,
          }}
          transition={{
            duration: 0.5,
            repeat: Infinity,
            repeatType: "reverse",
            delay: i * 0.1,
          }}
        />
      ))}
    </div>
  );
};

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
  const [callDuration, setCallDuration] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

  // allowIncoming controls whether manual incoming requests are accepted (if false -> auto-reject)
  const [allowIncoming, setAllowIncoming] = useState(true);

  // Audio analysis for visualizer
  useEffect(() => {
    if (localStreamRef.current && !audioContextRef.current) {
      try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(localStreamRef.current);
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateVolume = () => {
          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setIsSpeaking(average > 30);
          animationFrameRef.current = requestAnimationFrame(updateVolume);
        };
        updateVolume();
      } catch (e) {
        console.warn("Audio analysis failed", e);
      }
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Call duration timer
  useEffect(() => {
    let interval;
    if (isInCall) {
      interval = setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(interval);
  }, [isInCall]);

  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

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
          sampleRate: { ideal: 48000 },
          channelCount: 1,
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
      appendLog("[Error] Microphone not available (caller): " + err.message);
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
          sampleRate: { ideal: 48000 },
          channelCount: 1,
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
      appendLog("[Error] Microphone access denied/unavailable (callee): " + err.message);
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
    <div className="app-container">
      <div className="ambient-bg">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
      </div>

      <div className="app-content">
        {/* Header */}
        <motion.header
          className="header"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="logo">
            <div className="logo-icon">
              <Phone size={24} weight="fill" />
            </div>
            <span className="logo-text">AnyCall</span>
          </div>
          <div className="status-badge">
            {connected ? (
              <>
                <WifiHigh size={16} color="#10B981" />
                <span>Connected</span>
              </>
            ) : (
              <>
                <WifiNone size={16} color="#EF4444" />
                <span>Disconnected</span>
              </>
            )}
          </div>
        </motion.header>

        {/* Main Content */}
        <main className="main-content">
          {/* Call Status Card */}
          <AnimatePresence mode="wait">
            {isInCall ? (
              <motion.div
                key="call-card"
                className="call-card"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: "spring", damping: 20 }}
              >
                <div className="call-header">
                  <div className="call-avatar">
                    <Circle size={48} weight="fill" />
                    {isSpeaking && <span className="speaking-indicator"></span>}
                  </div>
                  <div className="call-info">
                    <h2>
                      {currentPartnerRef.current
                        ? `Calling ${shortId(currentPartnerRef.current)}`
                        : "In Call"}
                    </h2>
                    <div className="call-meta">
                      <Clock size={14} />
                      <span>{formatDuration(callDuration)}</span>
                    </div>
                  </div>
                  <AudioVisualizer isSpeaking={isSpeaking} isActive={isInCall} />
                </div>
                <div className="call-controls">
                  <button
                    className={`control-btn ${isMuted ? "muted" : ""}`}
                    onClick={toggleMute}
                    aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
                  >
                    {isMuted ? <MicrophoneSlash size={24} /> : <Microphone size={24} />}
                  </button>
                  <button className="control-btn hangup" onClick={hangup} aria-label="Hang up">
                    <PhoneDisconnect size={28} weight="fill" />
                  </button>
                  <button
                    className="control-btn"
                    onClick={enableAudioPlayback}
                    aria-label="Enable audio"
                  >
                    {isMuted ? <SpeakerNone size={24} /> : <SpeakerHigh size={24} />}
                  </button>
                </div>
              </motion.div>
            ) : incomingCall ? (
              <motion.div
                key="incoming-card"
                className="incoming-card"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: "spring", damping: 20 }}
              >
                <div className="incoming-header">
                  <div className="ringing-animation">
                    <Circle size={64} weight="fill" />
                    <motion.span
                      className="ring"
                      animate={{ scale: [1, 1.5], opacity: [0.8, 0] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    />
                    <motion.span
                      className="ring ring-2"
                      animate={{ scale: [1, 1.5], opacity: [0.8, 0] }}
                      transition={{ duration: 1.5, repeat: Infinity, delay: 0.3 }}
                    />
                  </div>
                  <div className="incoming-info">
                    <p className="incoming-label">Incoming Call</p>
                    <h2>{shortId(incomingCall.from)}</h2>
                  </div>
                </div>
                <div className="incoming-controls">
                  <button className="btn-decline" onClick={rejectIncoming}>
                    <PhoneDisconnect size={20} />
                    Decline
                  </button>
                  <button className="btn-accept" onClick={acceptIncoming}>
                    <Phone size={20} />
                    Accept
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle-card"
                className="idle-card"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="idle-content">
                  <div className="idle-icon">
                    <Phone size={48} weight="duotone" />
                  </div>
                  <h1>AnyCall Live</h1>
                  <p>Start an audio call or chat with others</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Controls Section */}
          <div className="controls-grid">
            <motion.div
              className="card"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <div className="card-header">
                <Users size={20} />
                <span>Online: {onlineList.length}</span>
              </div>
              <div className="card-actions">
                <button className="btn-ghost" onClick={requestHistory}>
                  <ClockCounterClockwise size={18} />
                  History
                </button>
                {autoActive ? (
                  <button className="btn btn-danger" onClick={stopAutoCall}>
                    Stop Auto
                  </button>
                ) : (
                  <button className="btn" onClick={startAutoCall}>
                    <Star size={18} />
                    Auto Call
                  </button>
                )}
              </div>
              <div className="card-footer">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={allowIncoming}
                    onChange={(e) => setAllowIncoming(e.target.checked)}
                  />
                  Allow Incoming
                </label>
              </div>
            </motion.div>

            <motion.div
              className="card chat-card"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <div className="card-header">
                <Chat size={20} />
                <span>Chat</span>
              </div>
              <div className="chat-messages" id="log">
                <AnimatePresence>
                  {msgLog.slice(-8).map((m) =>
                    m.system ? (
                      <motion.div
                        key={m.id}
                        className="message system"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                      >
                        {m.text}
                      </motion.div>
                    ) : (
                      <motion.div
                        key={m.id}
                        className={`message ${m.me ? "me" : "other"}`}
                        initial={{ opacity: 0, x: m.me ? 20 : -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0 }}
                      >
                        <span className="message-sender">{shortId(m.sender)}</span>
                        <span className="message-text">{m.text}</span>
                      </motion.div>
                    )
                  )}
                </AnimatePresence>
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Type a message..."
                  onKeyPress={(e) => e.key === "Enter" && sendChat()}
                />
                <button className="btn" onClick={sendChat}>
                  <ArrowRight size={18} />
                </button>
              </div>
            </motion.div>
          </div>
        </main>
      </div>

      {/* History Modal */}
      <AnimatePresence>
        {historyVisible && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setHistoryVisible(false)}
          >
            <motion.div
              className="modal-content"
              initial={{ scale: 0.9, y: 50 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 50 }}
              transition={{ type: "spring", damping: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2>Call History</h2>
                <button className="btn-icon" onClick={() => setHistoryVisible(false)}>
                  <X size={20} />
                </button>
              </div>
              <div className="history-list">
                {historyList.length === 0 ? (
                  <div className="empty-state">
                    <ClockCounterClockwise size={48} weight="duotone" />
                    <p>No call history yet</p>
                  </div>
                ) : (
                  historyList.map((h) => (
                    <motion.div
                      key={h.id}
                      className="history-item"
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                    >
                      <div className="history-avatar">
                        <Circle size={24} weight="fill" />
                        {h.online && <span className="online-dot"></span>}
                      </div>
                      <div className="history-info">
                        <span className="history-id">{shortId(h.id)}</span>
                        <span className="history-time">{fmtTime(h.last)}</span>
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => inviteCall(h.id)}
                        disabled={!h.online}
                      >
                        {h.online ? "Call" : "Offline"}
                      </button>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <audio ref={localAudioRef} autoPlay muted playsInline style={{ display: "none" }} />
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
    </div>
  );
}
// Deployed at Thu Nov  5 23:46:05 BST 2026
