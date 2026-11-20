// server/test/social.test.js
//
// Guest identity + social REST/socket features against a real server process.
// Run: node test/social.test.js
// The suite is intentionally Redis-agnostic: it works with the memory store
// and with REDIS_URL set (start a local Redis first if you want coverage).

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = Number(process.env.SOCIAL_TEST_PORT || 3212);
const URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "social-test-admin";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const serverLogs = [];
let serverProcess = null;

function logServer(chunk) {
  const text = chunk.toString();
  serverLogs.push(text);
  if (serverLogs.length > 200) serverLogs.shift();
}

async function waitFor(
  fn,
  { timeout = 10000, interval = 50, label = "condition" } = {}
) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `timeout waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`
  );
}

async function api(pathname, options = {}) {
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.admin) headers["x-admin-token"] = ADMIN_TOKEN;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${URL}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (e) {
    payload = null;
  }
  return { status: response.status, body: payload };
}

async function createGuest(overrides = {}) {
  const response = await api("/api/guest", {
    method: "POST",
    body: overrides,
  });
  assert.equal(response.status, 200, "guest creation failed");
  assert.ok(response.body.token, "guest token missing");
  assert.ok(response.body.profile && response.body.profile.id, "profile missing");
  return response.body;
}

function makeSocket() {
  const socket = io(URL, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  const events = {
    identified: [],
    errors: [],
    banned: [],
    presence: [],
    invites: [],
    autoReady: [],
    ringing: [],
    accepts: [],
    rejects: [],
    hangups: [],
    friendRequests: [],
    friendAccepted: [],
    friendRemoved: [],
    history: [],
  };
  socket.on("identified", (data) => events.identified.push(data));
  socket.on("identify-error", (data) => events.errors.push(data));
  socket.on("banned", (data) => events.banned.push(data));
  socket.on("presence", (data) => events.presence.push(data));
  socket.on("call-invite", (data) => events.invites.push(data));
  socket.on("auto-ready", (data) => events.autoReady.push(data));
  socket.on("call-ringing", (data) => events.ringing.push(data));
  socket.on("call-accept", (data) => events.accepts.push(data));
  socket.on("call-reject", (data) => events.rejects.push(data));
  socket.on("call-hangup", (data) => events.hangups.push(data));
  socket.on("friend-request", (data) => events.friendRequests.push(data));
  socket.on("friend-accepted", (data) => events.friendAccepted.push(data));
  socket.on("friend-removed", (data) => events.friendRemoved.push(data));
  socket.on("history", (data) => events.history.push(data));
  return { socket, events };
}

async function connectGuest(guest) {
  const client = makeSocket();
  await waitFor(() => client.socket.connected, {
    label: "socket connect",
    timeout: 15000,
  });
  client.socket.emit("identify", { token: guest.token });
  const identified = await waitFor(
    () => client.events.identified[0],
    { label: "identify", timeout: 10000 }
  );
  client.guestId = identified.guestId;
  client.socketId = client.socket.id;
  return client;
}

async function closeAll(clients) {
  clients.forEach((client) => {
    try {
      client.socket.close();
    } catch (e) {}
  });
  await sleep(150);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Date.now() - started}ms)`);
    if (detail) console.log(`      ${JSON.stringify(detail)}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

async function run() {
  await test("guest bootstrap, auth and profile updates", async () => {
    const bad = await api("/api/me", { token: "not-a-token" });
    assert.equal(bad.status, 401);

    const guest = await createGuest({
      name: "Test Otter",
      gender: "female",
      country: "bd",
      interests: ["Music", "music", "Travel"],
      filters: { gender: "male", country: "BD", interests: ["Music"] },
    });
    assert.equal(guest.profile.name, "Test Otter");
    assert.equal(guest.profile.country, "BD");
    assert.deepEqual(guest.profile.interests, ["Music", "Travel"]);
    assert.deepEqual(guest.profile.filters, {
      gender: "male",
      country: "BD",
      interests: ["Music"],
    });

    const me = await api("/api/me", { token: guest.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.profile.id, guest.profile.id);

    const patched = await api("/api/me", {
      method: "PATCH",
      token: guest.token,
      body: {
        name: "  Updated   Name  ",
        allowIncoming: false,
        interests: ["Gaming", "gaming", "Food"],
        filters: { gender: "any", country: "any", interests: [] },
      },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.profile.name, "Updated Name");
    assert.equal(patched.body.profile.allowIncoming, false);
    assert.deepEqual(patched.body.profile.interests, ["Gaming", "Food"]);
    assert.equal(patched.body.profile.filters.gender, "any");

    return { guestId: guest.profile.id };
  });

  await test("socket identify joins presence and empty history", async () => {
    const guest = await createGuest({ name: "Presence Fox", gender: "other" });
    const client = await connectGuest(guest);
    try {
      assert.equal(client.guestId, guest.profile.id);
      await waitFor(
        () => {
          const latest = client.events.presence.at(-1);
          return (
            latest &&
            latest.list.some(
              (item) =>
                item.guestId === guest.profile.id &&
                item.name === "Presence Fox"
            )
          );
        },
        { label: "presence with profile" }
      );

      client.socket.emit("get-history");
      const history = await waitFor(
        () => client.events.history.at(-1),
        { label: "history event" }
      );
      assert.deepEqual(history.list, []);
      return { guestId: client.guestId };
    } finally {
      await closeAll([client]);
    }
  });

  await test("mutual filters match compatible guests only", async () => {
    const a = await createGuest({
      name: "Filter A",
      gender: "male",
      country: "BD",
      interests: ["Music"],
      filters: { gender: "female", country: "BD", interests: [] },
    });
    const b = await createGuest({
      name: "Filter B",
      gender: "female",
      country: "BD",
      interests: [],
      filters: { gender: "male", country: "ANY", interests: ["music"] },
    });
    const c = await createGuest({
      name: "Filter C",
      gender: "female",
      country: "US",
      interests: ["Sports"],
      filters: { gender: "male", country: "US", interests: [] },
    });

    const ca = await connectGuest(a);
    const cb = await connectGuest(b);
    const cc = await connectGuest(c);
    try {
      [ca, cb, cc].forEach((client) =>
        client.socket.emit("auto-call-start", {})
      );

      const state = await waitFor(
        async () => {
          const response = await fetch(`${URL}/debug/state`);
          const data = await response.json();
          return data.calls.length === 1 && data.queueSize === 1 ? data : null;
        },
        { label: "one compatible pair", timeout: 15000 }
      );

      const call = state.calls[0];
      const ids = [call.caller, call.callee].sort();
      const expected = [ca.socketId, cb.socketId].sort();
      assert.deepEqual(ids, expected, "wrong pair matched");

      // Each matched side receives exactly one match event; the waiting
      // guest receives none.
      const matchedEvents = [ca, cb].map(
        (client) =>
          client.events.accepts.length + client.events.autoReady.length
      );
      assert.deepEqual(matchedEvents.sort(), [1, 1], "match events wrong");
      assert.equal(
        cc.events.accepts.length + cc.events.autoReady.length,
        0,
        "incompatible guest received a match event"
      );
      return { pair: [a.profile.name, b.profile.name], waiting: c.profile.name };
    } finally {
      await closeAll([ca, cb, cc]);
    }
  });

  await test("friends request, accept and remove", async () => {
    const a = await createGuest({ name: "Friend A" });
    const b = await createGuest({ name: "Friend B" });
    const ca = await connectGuest(a);
    const cb = await connectGuest(b);
    try {
      const request = await api("/api/friends/requests", {
        method: "POST",
        token: a.token,
        body: { toGuestId: b.profile.id },
      });
      assert.equal(request.status, 200);
      assert.equal(request.body.status, "pending");

      const event = await waitFor(
        () => cb.events.friendRequests[0],
        { label: "friend request event" }
      );
      assert.equal(event.from.guestId, a.profile.id);
      assert.equal(event.from.name, "Friend A");

      const pending = await api("/api/friends", { token: b.token });
      assert.equal(pending.body.incoming.length, 1);
      assert.equal(pending.body.incoming[0].guestId, a.profile.id);
      assert.equal(pending.body.incoming[0].online, true);

      const accepted = await api(`/api/friends/requests/${a.profile.id}/accept`, {
        method: "POST",
        token: b.token,
      });
      assert.equal(accepted.status, 200);

      await waitFor(
        () => cb.events.friendAccepted[0],
        { label: "friend accepted event" }
      );

      const listA = await api("/api/friends", { token: a.token });
      const listB = await api("/api/friends", { token: b.token });
      assert.equal(listA.body.friends.length, 1);
      assert.equal(listA.body.friends[0].guestId, b.profile.id);
      assert.equal(listB.body.friends[0].guestId, a.profile.id);

      const removed = await api(`/api/friends/${b.profile.id}`, {
        method: "DELETE",
        token: a.token,
      });
      assert.equal(removed.status, 200);
      await waitFor(
        () => cb.events.friendRemoved[0],
        { label: "friend removed event" }
      );
      const after = await api("/api/friends", { token: a.token });
      assert.equal(after.body.friends.length, 0);
      return { friends: 1 };
    } finally {
      await closeAll([ca, cb]);
    }
  });

  await test("blocked guests cannot invite each other", async () => {
    const a = await createGuest({ name: "Block A" });
    const b = await createGuest({ name: "Block B" });
    const ca = await connectGuest(a);
    const cb = await connectGuest(b);
    try {
      const blocked = await api(`/api/blocks/${b.profile.id}`, {
        method: "POST",
        token: a.token,
      });
      assert.equal(blocked.status, 200);

      ca.socket.emit("call-invite", { to: cb.socketId });
      const rejected = await waitFor(
        () => ca.events.rejects[0],
        { label: "blocked invite reject" }
      );
      assert.equal(rejected.reason, "blocked");
      assert.equal(cb.events.invites.length, 0, "blocked invite was delivered");

      const blocks = await api("/api/blocks", { token: a.token });
      assert.deepEqual(blocks.body.list, [b.profile.id]);
      return { reason: rejected.reason };
    } finally {
      await closeAll([ca, cb]);
    }
  });

  await test("call history is recorded for both guests", async () => {
    const a = await createGuest({ name: "History A", country: "BD" });
    const b = await createGuest({ name: "History B", country: "US" });
    const ca = await connectGuest(a);
    const cb = await connectGuest(b);
    try {
      ca.socket.emit("call-invite", { to: cb.socketId });
      const invite = await waitFor(
        () => cb.events.invites[0],
        { label: "history invite" }
      );
      assert.equal(invite.partner.name, "History A");

      cb.socket.emit("call-accept", {
        to: ca.socketId,
        callId: invite.callId,
      });
      await waitFor(
        () => ca.events.accepts.find((event) => event.callId === invite.callId),
        { label: "history accept" }
      );

      ca.socket.emit("call-connected", { callId: invite.callId });
      cb.socket.emit("call-connected", { callId: invite.callId });
      await sleep(300);
      ca.socket.emit("call-hangup", {
        to: cb.socketId,
        callId: invite.callId,
      });

      const listA = await waitFor(
        async () => {
          const response = await api("/api/history", { token: a.token });
          return response.body.list.length === 1 ? response.body.list : null;
        },
        { label: "history for A" }
      );
      const listB = await waitFor(
        async () => {
          const response = await api("/api/history", { token: b.token });
          return response.body.list.length === 1 ? response.body.list : null;
        },
        { label: "history for B" }
      );

      assert.equal(listA[0].partnerName, "History B");
      assert.equal(listA[0].partnerGuestId, b.profile.id);
      assert.equal(listA[0].country, "US");
      assert.equal(listA[0].direction, "outgoing");
      assert.equal(listA[0].reason, "hangup");
      assert.equal(listB[0].direction, "incoming");
      assert.equal(listB[0].partnerName, "History A");

      const event = await (async () => {
        ca.socket.emit("get-history");
        return waitFor(() => ca.events.history.at(-1), {
          label: "socket history",
        });
      })();
      assert.equal(event.list.length, 1);
      assert.equal(event.list[0].callId, invite.callId);
      return { direction: [listA[0].direction, listB[0].direction] };
    } finally {
      await closeAll([ca, cb]);
    }
  });

  await test("reports, admin access and guest bans", async () => {
    const a = await createGuest({ name: "Reporter A" });
    const b = await createGuest({ name: "Reported B" });
    const ca = await connectGuest(a);
    const cb = await connectGuest(b);
    try {
      const reported = await api("/api/reports", {
        method: "POST",
        token: a.token,
        body: {
          targetGuestId: b.profile.id,
          reason: "harassment",
          details: "test report",
        },
      });
      assert.equal(reported.status, 200);

      const forbidden = await api("/api/admin/reports");
      assert.equal(forbidden.status, 403);

      const reports = await api("/api/admin/reports", { admin: true });
      assert.equal(reports.status, 200);
      const match = reports.body.list.find(
        (report) =>
          report.reporterId === a.profile.id &&
          report.targetGuestId === b.profile.id
      );
      assert.ok(match, "report missing from admin list");
      assert.equal(match.reason, "harassment");

      const banned = await api("/api/admin/ban", {
        method: "POST",
        admin: true,
        body: { guestId: b.profile.id, reason: "test ban" },
      });
      assert.equal(banned.status, 200);

      await waitFor(() => cb.events.banned[0] || !cb.socket.connected, {
        label: "banned socket disconnected",
        timeout: 10000,
      });

      // A banned guest cannot re-identify on a fresh socket.
      const retry = makeSocket();
      await waitFor(() => retry.socket.connected, {
        label: "retry connect",
      });
      retry.socket.emit("identify", { token: b.token });
      const banEvent = await waitFor(() => retry.events.banned[0], {
        label: "banned identify",
        timeout: 10000,
      });
      assert.equal(banEvent.reason, "test ban");
      retry.socket.close();

      await api("/api/admin/unban", {
        method: "POST",
        admin: true,
        body: { guestId: b.profile.id },
      });
      const allowed = makeSocket();
      await waitFor(() => allowed.socket.connected, {
        label: "unbanned connect",
      });
      allowed.socket.emit("identify", { token: b.token });
      const identified = await waitFor(() => allowed.events.identified[0], {
        label: "unbanned identify",
      });
      assert.equal(identified.guestId, b.profile.id);
      allowed.socket.close();
      return { banned: true, unbanned: true };
    } finally {
      await closeAll([ca, cb]);
    }
  });
}

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    ADMIN_TOKEN,
    CALL_TIMEOUT_MS: "8000",
    MATCH_INTERVAL_MS: "100",
    MATCH_COOLDOWN_MS: "200",
  };

  serverProcess = spawn(
    process.execPath,
    [path.join(__dirname, "..", "index.js")],
    {
      env,
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  serverProcess.stdout.on("data", logServer);
  serverProcess.stderr.on("data", logServer);

  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${URL}/health`);
          return response.ok;
        } catch (e) {
          return false;
        }
      },
      { label: "server health", timeout: 20000 }
    );
    console.log(
      `Server ready on ${URL} (store=${process.env.REDIS_URL ? "redis" : "memory"})`
    );
    await run();
  } finally {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await sleep(300);
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log("\n===== SUMMARY =====");
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((failure) =>
      console.log(`  FAILED: ${failure.name} -> ${failure.error}`)
    );
    console.log("\n--- server log tail ---");
    console.log(serverLogs.join("").split("\n").slice(-40).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ALL TESTS PASSED");
  }
}

main().catch((err) => {
  console.error("TEST RUNNER ERROR:", err);
  console.log(serverLogs.join("").split("\n").slice(-60).join("\n"));
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
