// server/test/multi-instance.test.js
//
// Two real backend processes share one Redis. Clients are connected to
// different instances, so this verifies:
//   - atomic reservations across instances
//   - Socket.IO Redis adapter delivery across instances
//   - cross-instance manual calls, chat and signaling
//   - idempotent simultaneous hangups across instances
//   - reconnect + auto requeue across instances
//
// Requires a running Redis. Example:
//   $env:REDIS_URL="redis://127.0.0.1:6380"; node test/multi-instance.test.js

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");
const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";

// This suite calls FLUSHDB. Never point it at a shared/production Redis.
try {
  const host = new URL(REDIS_URL).hostname;
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"];
  if (!local.includes(host) && process.env.ALLOW_REMOTE_REDIS_TEST !== "1") {
    console.error(
      `Refusing to flush remote Redis at ${host}. ` +
        "Set ALLOW_REMOTE_REDIS_TEST=1 only on a disposable database."
    );
    process.exit(1);
  }
} catch (err) {
  console.error("Invalid REDIS_URL:", err.message);
  process.exit(1);
}
const PORT_A = Number(process.env.INSTANCE_A_PORT || 3212);
const PORT_B = Number(process.env.INSTANCE_B_PORT || 3213);
const URL_A = `http://127.0.0.1:${PORT_A}`;
const URL_B = `http://127.0.0.1:${PORT_B}`;
const CALL_TIMEOUT_MS = 8000;
const COOLDOWN_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const logs = [];
const processes = [];

async function waitFor(fn, { timeout = 12000, interval = 50, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {}
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function getState(url = URL_A) {
  const response = await fetch(`${url}/debug/state`);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  return response.json();
}

function startInstance(port) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      REDIS_URL,
      CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS),
      MATCH_INTERVAL_MS: "100",
      MATCH_COOLDOWN_MS: String(COOLDOWN_MS),
    },
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(`[${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => logs.push(`[${port}] ${chunk}`));
  processes.push(proc);
  return proc;
}

function makeClient(url, label) {
  const sock = io(url, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  const events = {
    invite: [],
    autoReady: [],
    accept: [],
    reject: [],
    hangup: [],
    ringing: [],
    signal: [],
    chat: [],
  };
  sock.on("call-invite", (data) => events.invite.push({ ...data, at: Date.now() }));
  sock.on("auto-ready", (data) => events.autoReady.push({ ...data, at: Date.now() }));
  sock.on("call-accept", (data) => events.accept.push({ ...data, at: Date.now() }));
  sock.on("call-reject", (data) => events.reject.push({ ...data, at: Date.now() }));
  sock.on("call-hangup", (data) => events.hangup.push({ ...data, at: Date.now() }));
  sock.on("call-ringing", (data) => events.ringing.push({ ...data, at: Date.now() }));
  sock.on("signal", (data) => events.signal.push({ ...data, at: Date.now() }));
  sock.on("chat", (data) => events.chat.push({ ...data, at: Date.now() }));
  return { label, url, sock, events };
}

async function connect(url, label) {
  const client = makeClient(url, label);
  await waitFor(() => client.sock.connected, {
    label: `${label} connect`,
    timeout: 15000,
  });
  return client;
}

async function closeAll(clients) {
  clients.forEach((client) => {
    try {
      client.sock.close();
    } catch (e) {}
  });
  await waitFor(
    async () => {
      const state = await getState();
      return state.users.length === 0 && state.calls.length === 0;
    },
    { label: "cluster cleanup", timeout: 20000 }
  );
}

function find(clients, id) {
  return clients.find((client) => client.sock.id === id);
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
  await test("auto Call pairs a user on instance A with a user on instance B", async () => {
    const a = await connect(URL_A, "auto-cross-A");
    const b = await connect(URL_B, "auto-cross-B");
    try {
      a.sock.emit("auto-call-start", {});
      b.sock.emit("auto-call-start", {});

      const call = await waitFor(
        async () => {
          const current = await getState();
          if (current.calls.length !== 1) return null;
          const item = current.calls[0];
          const ids = [item.caller, item.callee];
          return ids.includes(a.sock.id) && ids.includes(b.sock.id) ? item : null;
        },
        { label: "cross-instance auto pair", timeout: 20000 }
      );

      const caller = find([a, b], call.caller);
      const callee = find([a, b], call.callee);
      assert.ok(
        caller.events.accept.some((event) => event.callId === call.id),
        "cross-instance caller never received call-accept"
      );
      assert.ok(
        callee.events.autoReady.some((event) => event.callId === call.id),
        "cross-instance callee never received auto-ready"
      );

      a.sock.emit("auto-call-stop", {});
      b.sock.emit("auto-call-stop", {});
      await sleep(300);
      a.sock.emit("call-hangup", {
        to: b.sock.id,
        callId: call.id,
      });
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "cross-instance auto hangup",
      });

      return { callId: call.id };
    } finally {
      await closeAll([a, b]);
    }
  });

  await test("40 auto users across two instances form 20 unique calls", async () => {
    const clients = [];
    for (let i = 0; i < 20; i += 1) {
      clients.push(await connect(URL_A, `a${i}`));
    }
    for (let i = 0; i < 20; i += 1) {
      clients.push(await connect(URL_B, `b${i}`));
    }

    try {
      // Deliver starts in interleaved batches from both instances.
      for (let i = 0; i < 20; i += 1) {
        clients[i].sock.emit("auto-call-start", {});
        clients[i + 20].sock.emit("auto-call-start", {});
      }

      const state = await waitFor(
        async () => {
          const current = await getState();
          if (current.calls.length !== 20) return null;
          const participants = new Set(
            current.calls.flatMap((call) => [call.caller, call.callee])
          );
          if (participants.size !== 40) return null;
          const eventsReady = current.calls.every((call) => {
            const caller = find(clients, call.caller);
            const callee = find(clients, call.callee);
            return (
              caller &&
              callee &&
              caller.events.accept.some((event) => event.callId === call.id) &&
              callee.events.autoReady.some((event) => event.callId === call.id)
            );
          });
          return eventsReady ? current : null;
        },
        { label: "cross-instance pairing", timeout: 25000 }
      );

      const pairs = new Set(
        state.calls.map((call) => [call.caller, call.callee].sort().join("|"))
      );
      assert.equal(pairs.size, 20, "duplicate pair");
      assert.equal(state.queueSize, 0);

      const crossInstance = state.calls.filter((call) => {
        const caller = find(clients, call.caller);
        const callee = find(clients, call.callee);
        return caller.url !== callee.url;
      });
      // Cross-instance pairing is verified deterministically in its own test
      // below; queue ordering may legitimately pair everyone within one
      // instance when starts arrive in bursts.

      // Both instances must see the same shared state.
      const stateB = await getState(URL_B);
      assert.equal(stateB.calls.length, state.calls.length);
      assert.equal(stateB.users.length, state.users.length);

      // Turn Auto OFF so the hangup round does not immediately rematch.
      clients.forEach((client) => client.sock.emit("auto-call-stop", {}));
      await sleep(500);

      clients.forEach((client) => {
        const call = state.calls.find(
          (item) =>
            item.caller === client.sock.id || item.callee === client.sock.id
        );
        client.sock.emit("call-hangup", {
          to: call.caller === client.sock.id ? call.callee : call.caller,
          callId: call.id,
        });
      });

      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "cluster hangup cleanup",
        timeout: 20000,
      });
      await sleep(1000);

      const duplicate = clients.find(
        (client) => client.events.hangup.length !== 1
      );
      assert.ok(
        !duplicate,
        duplicate
          ? `${duplicate.label} got ${duplicate.events.hangup.length} hangups`
          : "duplicate hangup"
      );
      assert.equal((await getState()).queueSize, 0);

      return {
        calls: state.calls.length,
        crossInstance: crossInstance.length,
        hangups: clients.length,
      };
    } finally {
      await closeAll(clients);
    }
  });

  await test("cross-instance manual call: invite, accept, signal, chat", async () => {
    const a = await connect(URL_A, "caller-A");
    const b = await connect(URL_B, "callee-B");
    try {
      a.sock.emit("call-invite", { to: b.sock.id });
      const invite = await waitFor(
        () => b.events.invite.find((event) => event.from === a.sock.id),
        { label: "cross-instance invite" }
      );
      b.sock.emit("call-accept", { to: a.sock.id, callId: invite.callId });
      const accepted = await waitFor(
        () =>
          a.events.accept.find(
            (event) => event.from === b.sock.id && event.callId === invite.callId
          ),
        { label: "cross-instance accept" }
      );

      // Signaling must be routed by the adapter to the other instance.
      b.sock.emit("signal", {
        to: a.sock.id,
        callId: invite.callId,
        data: { candidate: { candidate: "cross-instance" } },
      });
      const signal = await waitFor(
        () =>
          a.events.signal.find(
            (event) => event.callId === invite.callId && event.data
          ),
        { label: "cross-instance signal" }
      );

      a.sock.emit("chat", { to: b.sock.id, text: "hello across instances" });
      const chat = await waitFor(
        () =>
          b.events.chat.find((event) => event.text === "hello across instances"),
        { label: "cross-instance chat" }
      );

      a.sock.emit("call-hangup", {
        to: b.sock.id,
        callId: invite.callId,
        reason: "hangup",
      });
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "cross-instance hangup",
      });

      return {
        callId: invite.callId,
        accepted: accepted.callId === invite.callId,
        signal: !!signal,
        chat: !!chat,
      };
    } finally {
      await closeAll([a, b]);
    }
  });

  await test("reconnect + auto requeue works across instances", async () => {
    const a = await connect(URL_A, "reconnect-A");
    const b = await connect(URL_B, "reconnect-B");
    let replacement = null;
    try {
      a.sock.emit("auto-call-start", {});
      b.sock.emit("auto-call-start", {});
      const first = await waitFor(
        async () => {
          const state = await getState();
          if (state.calls.length !== 1) return null;
          const call = state.calls[0];
          const ids = [call.caller, call.callee];
          return ids.includes(a.sock.id) && ids.includes(b.sock.id)
            ? call
            : null;
        },
        { label: "initial cross-instance auto pair" }
      );

      a.sock.close();
      await waitFor(
        () => b.events.hangup.find((event) => event.callId === first.id),
        { label: "partner disconnect notice" }
      );

      replacement = await connect(URL_A, "reconnect-A2");
      replacement.sock.emit("auto-call-start", {});
      const second = await waitFor(
        async () => {
          const state = await getState();
          if (state.calls.length !== 1) return null;
          const call = state.calls[0];
          const ids = [call.caller, call.callee];
          return ids.includes(replacement.sock.id) &&
            ids.includes(b.sock.id) &&
            call.id !== first.id
            ? call
            : null;
        },
        { label: "cross-instance requeue" }
      );

      return { first: first.id, second: second.id };
    } finally {
      replacement && replacement.sock.close();
      b.sock.close();
      await waitFor(async () => (await getState()).users.length === 0, {
        label: "reconnect cleanup",
      });
    }
  });
}

async function main() {
  const redis = createClient({ url: REDIS_URL });
  await redis.connect();
  await redis.flushDb();
  await redis.quit();

  startInstance(PORT_A);
  startInstance(PORT_B);

  try {
    await waitFor(
      async () => {
        try {
          const [a, b] = await Promise.all([
            fetch(`${URL_A}/health`),
            fetch(`${URL_B}/health`),
          ]);
          return a.ok && b.ok;
        } catch (e) {
          return false;
        }
      },
      { label: "both instances healthy", timeout: 25000 }
    );
    console.log(`Instances ready on ${URL_A} and ${URL_B} (shared Redis)`);
    await run();
  } finally {
    processes.forEach((proc) => proc.kill("SIGTERM"));
    await sleep(500);
    processes.forEach((proc) => {
      if (!proc.killed) proc.kill("SIGKILL");
    });
    const cleanup = createClient({ url: REDIS_URL });
    await cleanup.connect();
    await cleanup.flushDb();
    await cleanup.quit();
  }

  const failed = results.filter((result) => !result.ok);
  console.log("\n===== SUMMARY =====");
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((failure) =>
      console.log(`  FAILED: ${failure.name} -> ${failure.error}`)
    );
    console.log("\n--- server log tail ---");
    console.log(logs.join("").split("\n").slice(-50).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ALL MULTI-INSTANCE TESTS PASSED");
  }
}

main().catch((err) => {
  console.error("TEST RUNNER ERROR:", err);
  console.log(logs.join("").split("\n").slice(-60).join("\n"));
  processes.forEach((proc) => proc.kill("SIGKILL"));
  process.exit(1);
});
