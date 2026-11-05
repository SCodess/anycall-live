// server-index.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

const users = new Map();
const autoQueue = [];
const matches = new Map();
const history = [];

function countryToFlag(cc) {
  if (!cc || typeof cc !== "string" || cc.length !== 2) return "🏳️";
  return String.fromCodePoint(
    0x1f1e6 + cc.toUpperCase().charCodeAt(0) - 65,
    0x1f1e6 + cc.toUpperCase().charCodeAt(1) - 65
  );
}

function emitPresenceToAll() {
  const list = Array.from(users.values()).map((u) => ({
    id: u.id,
    country: u.country || null,
    flag: countryToFlag(u.country),
    online: true,
    autoActive: !!u.autoActive,
  }));
  io.emit("presence", { count: list.length, list });
}

function pushHistoryEntry(uid, country) {
  const entry = {
    id: uid,
    country: country || null,
    flag: countryToFlag(country),
    last: Date.now(),
    online: !!users.has(uid),
  };
  history.unshift(entry);
  if (history.length > 200) history.pop();
}

function isInAutoQueue(id) {
  return autoQueue.indexOf(id) !== -1;
}
function addToAutoQueue(id) {
  if (!users.has(id)) return;
  if (!isInAutoQueue(id)) autoQueue.push(id);
}
function removeFromAutoQueue(id) {
  const i = autoQueue.indexOf(id);
  if (i >= 0) autoQueue.splice(i, 1);
}
function removeIfMatchedFromQueue(id) {
  if (isInAutoQueue(id)) removeFromAutoQueue(id);
}

function getRandomPartnerFromQueue(excludeId) {
  if (autoQueue.length === 0) return null;
  const candidates = autoQueue.filter(
    (s) => s !== excludeId && users.has(s) && users.get(s).autoActive
  );
  if (!candidates.length) return null;
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}

function tryMatchAuto() {
  while (autoQueue.length >= 2) {
    const idxA = Math.floor(Math.random() * autoQueue.length);
    const idA = autoQueue[idxA];
    let idxB = idxA;
    while (idxB === idxA && autoQueue.length > 1) {
      idxB = Math.floor(Math.random() * autoQueue.length);
    }
    const idB = autoQueue[idxB];
    if (!idA || !idB || idA === idB) break;
    removeFromAutoQueue(idA);
    removeFromAutoQueue(idB);
    if (!users.has(idA) || !users.has(idB)) {
      if (users.has(idA)) addToAutoQueue(idA);
      if (users.has(idB)) addToAutoQueue(idB);
      continue;
    }
    matches.set(idA, idB);
    matches.set(idB, idA);
    const caller = idA;
    const callee = idB;
    console.log(`[auto-match] paired ${caller} -> ${callee}`);
    io.to(callee).emit("auto-ready", { from: caller });
    io.to(caller).emit("call-accept", { from: callee });
    pushHistoryEntry(caller, users.get(caller).country);
    pushHistoryEntry(callee, users.get(callee).country);
  }
}

function onCallEndedAndTryRematch(leaverId, partnerId) {
  if (matches.has(leaverId) && matches.get(leaverId) === partnerId)
    matches.delete(leaverId);
  if (matches.has(partnerId) && matches.get(partnerId) === leaverId)
    matches.delete(partnerId);
  if (users.has(leaverId))
    pushHistoryEntry(leaverId, users.get(leaverId).country);
  if (users.has(partnerId))
    pushHistoryEntry(partnerId, users.get(partnerId).country);
  if (!partnerId || !users.has(partnerId)) return;
  const partner = users.get(partnerId);
  if (partner.autoActive) {
    removeFromAutoQueue(partnerId);
    const candidate = getRandomPartnerFromQueue(partnerId);
    if (candidate) {
      removeFromAutoQueue(candidate);
      matches.set(partnerId, candidate);
      matches.set(candidate, partnerId);
      io.to(candidate).emit("auto-ready", { from: partnerId });
      io.to(partnerId).emit("call-accept", { from: candidate });
      console.log(`[auto-rematch] ${partnerId} -> ${candidate}`);
      return;
    }
    const normalCandidates = Array.from(users.keys()).filter(
      (id) => id !== partnerId && !users.get(id).autoActive
    );
    if (normalCandidates.length > 0) {
      const cidx = Math.floor(Math.random() * normalCandidates.length);
      const target = normalCandidates[cidx];
      io.to(target).emit("call-invite", { from: partnerId });
      console.log(
        `[auto-rematch-invite] ${partnerId} invited ${target} (normal user)`
      );
      return;
    }
    addToAutoQueue(partnerId);
    io.to(partnerId).emit("auto-complete", {
      note: "No partner available currently — waiting in auto queue",
    });
  } else {
    // nothing
  }
}

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);
  users.set(socket.id, {
    id: socket.id,
    socket,
    country: null,
    autoActive: false,
    allowIncoming: true,
    lastSeen: Date.now(),
  });
  emitPresenceToAll();

  socket.on("announce-location", ({ country }) => {
    const u = users.get(socket.id) || {};
    u.country =
      country && typeof country === "string" ? country.toUpperCase() : null;
    users.set(socket.id, u);
    emitPresenceToAll();
  });

  socket.on("get-history", () => {
    socket.emit("history", { list: history.slice(0, 100) });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { id: socket.id, data });
  });

  socket.on("call-invite", ({ to, from }) => {
    if (!to) return;
    if (!users.has(to)) {
      socket.emit("error", { message: "Target not online" });
      return;
    }
    io.to(to).emit("call-invite", { from: socket.id });
  });

  socket.on("call-accept", ({ to, from }) => {
    if (to) io.to(to).emit("call-accept", { from: socket.id });
  });
  socket.on("call-reject", ({ to, from }) => {
    if (to) io.to(to).emit("call-reject", { from: socket.id });
  });
  socket.on("call-hangup", ({ to, from }) => {
    if (to) io.to(to).emit("call-hangup", { from: socket.id });
    const partner = matches.get(socket.id);
    if (partner) {
      matches.delete(socket.id);
      matches.delete(partner);
      io.to(partner).emit("call-hangup", { from: socket.id });
      onCallEndedAndTryRematch(socket.id, partner);
    }
  })

  // Chat forwarding (fallback when datachannel isn't available)
  socket.on("chat", ({ to, message }) => {
    if (!to || !message) return;
    try {
      // trim message when logging to avoid huge outputs
      const preview = (typeof message === "string" && message.length > 120) ? message.slice(0, 120) + "..." : message;
      console.log(`[chat] ${socket.id} -> ${to}: ${preview}`);
      io.to(to).emit("chat", { from: socket.id, message });
    } catch (e) {
      console.error("[chat] forward failed", e);
    }
  });

  socket.on("auto-call-start", ({ initiator }) => {
    const u = users.get(socket.id);
    if (!u) return;
    u.autoActive = true;
    users.set(socket.id, u);
    addToAutoQueue(socket.id);
    tryMatchAuto();
    emitPresenceToAll();
  });

  socket.on("auto-call-stop", ({ initiator }) => {
    const u = users.get(socket.id);
    if (!u) return;
    u.autoActive = false;
    users.set(socket.id, u);
    removeFromAutoQueue(socket.id);
    io.to(socket.id).emit("auto-stopped", {});
    emitPresenceToAll();
  });

  socket.on("log", (d) => console.log("CLIENT LOG", socket.id, d));

  socket.on("disconnect", (reason) => {
    console.log("disconnected:", socket.id, reason);
    const u = users.get(socket.id);
    if (u) {
      removeFromAutoQueue(socket.id);
      const partner = matches.get(socket.id);
      if (partner) {
        matches.delete(partner);
        matches.delete(socket.id);
        io.to(partner).emit("call-hangup", { from: socket.id });
        onCallEndedAndTryRematch(socket.id, partner);
      }
      users.delete(socket.id);
      pushHistoryEntry(socket.id, u.country);
    }
    emitPresenceToAll();
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log("Socket.IO server ready.");
});
