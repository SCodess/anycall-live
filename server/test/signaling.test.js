// server/test/signaling.test.js
//
// End-to-end signaling / matchmaking tests against a real server process.
// Run: node test/signaling.test.js
// With Redis: set REDIS_URL before running (the server will use it).

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = Number(process.env.TEST_PORT || 3210);
const URL = `http://127.0.0.1:${PORT}`;
const CALL_TIMEOUT_MS = 8000;
const COOLDOWN_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let serverProcess = null;
const serverLogs = [];

function logServer(chunk) {
  const text = chunk.toString();
  serverLogs.push(text);
  if (serverLogs.length > 200) serverLogs.shift();
}

async function waitFor(fn, { timeout = 10000, interval = 50, label = "condition" } = {}) {
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

async function getState() {
  const response = await fetch(`${URL}/debug/state`);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  return response.json();
}

function makeClient(label) {
  const sock = io(URL, {
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
  return { label, sock, events };
}

async function connectClients(count, prefix = "u") {
  const clients = Array.from({ length: count }, (_, index) =>
    makeClient(`${prefix}${index}`)
  );
  await Promise.all(
    clients.map((client) =>
      waitFor(() => client.sock.connected, {
        label: `${client.label} connect`,
        timeout: 15000,
      })
    )
  );
  return clients;
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
    { label: "server cleanup", timeout: 15000 }
  );
}

async function withClients(count, fn, prefix) {
  const clients = await connectClients(count, prefix);
  try {
    return await fn(clients);
  } finally {
    await closeAll(clients);
  }
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS  ${name}  (${Date.now() - started}ms)`);
    if (detail) console.log(`      ${JSON.stringify(detail)}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message, ms: Date.now() - started });
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function findClient(clients, id) {
  return clients.find((client) => client.sock.id === id);
}

async function pairAuto(clients) {
  clients.forEach((client) => client.sock.emit("auto-call-start", {}));
  return waitFor(
    async () => {
      const state = await getState();
      if (state.calls.length !== 1) return null;
      const call = state.calls[0];
      const caller = findClient(clients, call.caller);
      const callee = findClient(clients, call.callee);
      if (!caller || !callee) return null;
      const callerSaw = caller.events.accept.some(
        (event) => event.callId === call.id && event.from === call.callee
      );
      const calleeSaw = callee.events.autoReady.some(
        (event) => event.callId === call.id && event.from === call.caller
      );
      return callerSaw && calleeSaw ? { call, caller, callee } : null;
    },
    { label: "auto pair", timeout: 12000 }
  );
}

async function createManualCall(inviter, callee) {
  const invitesBefore = callee.events.invite.length;
  const acceptsBefore = inviter.events.accept.length;
  inviter.sock.emit("call-invite", { to: callee.sock.id });
  const invite = await waitFor(
    () =>
      callee.events.invite
        .slice(invitesBefore)
        .find((event) => event.from === inviter.sock.id),
    { label: "call invite" }
  );
  callee.sock.emit("call-accept", {
    to: inviter.sock.id,
    callId: invite.callId,
  });
  const accepted = await waitFor(
    () =>
      inviter.events.accept
        .slice(acceptsBefore)
        .find(
          (event) =>
            event.from === callee.sock.id && event.callId === invite.callId
        ),
    { label: "call accept" }
  );
  return { callId: invite.callId, invite, accepted };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

async function run() {
  for (const count of [2, 4, 9, 100]) {
    await test(`auto match ${count} concurrent queue users`, async () => {
      return withClients(
        count,
        async (clients) => {
          // Duplicate start events must not create duplicate calls.
          clients.forEach((client) => {
            client.sock.emit("auto-call-start", {});
            client.sock.emit("auto-call-start", {});
          });

          const expected = Math.floor(count / 2);
          const state = await waitFor(
            async () => {
              const current = await getState();
              if (current.calls.length !== expected) return null;
              const participants = new Set(
                current.calls.flatMap((call) => [call.caller, call.callee])
              );
              if (participants.size !== expected * 2) return null;
              const eventsReady = current.calls.every((call) => {
                const caller = findClient(clients, call.caller);
                const callee = findClient(clients, call.callee);
                return (
                  caller &&
                  callee &&
                  caller.events.accept.some((e) => e.callId === call.id) &&
                  callee.events.autoReady.some((e) => e.callId === call.id)
                );
              });
              return eventsReady ? current : null;
            },
            { label: `${count} users paired`, timeout: 20000 }
          );

          const pairs = new Set();
          for (const call of state.calls) {
            pairs.add([call.caller, call.callee].sort().join("|"));
          }
          assert.equal(pairs.size, expected, "duplicate pair detected");
          assert.equal(state.queueSize, count % 2, "unexpected queue size");

          // A single auto-active user must never hold two calls.
          const seen = new Map();
          for (const call of state.calls) {
            for (const id of [call.caller, call.callee]) {
              const already = seen.get(id);
              assert.ok(
                !already || already === call.id,
                `user ${id} is in two calls`
              );
              seen.set(id, call.id);
            }
          }

          // Report real WebRTC connectivity (idempotent for both peers).
          state.calls.forEach((call) => {
            findClient(clients, call.caller).sock.emit("call-connected", {
              callId: call.id,
            });
            findClient(clients, call.callee).sock.emit("call-connected", {
              callId: call.id,
            });
          });
          await waitFor(
            async () => (await getState()).calls.every((c) => c.state === "active"),
            { label: "calls active" }
          );

          return { calls: state.calls.length, queue: state.queueSize };
        },
        `n${count}-`
      );
    });
  }

  await test("simultaneous invites reserve one callee atomically", async () => {
    return withClients(3, async (clients) => {
      const [a, b, c] = clients;

      a.sock.emit("call-invite", { to: c.sock.id });
      b.sock.emit("call-invite", { to: c.sock.id });

      const state = await waitFor(
        async () => {
          const current = await getState();
          return current.calls.length === 1 ? current : null;
        },
        { label: "single invite call" }
      );
      await sleep(400);

      const call = state.calls[0];
      assert.equal(c.events.invite.length, 1, "callee saw duplicate invites");
      const winner = call.caller === a.sock.id ? a : b;
      const loser = winner === a ? b : a;
      assert.equal(winner.sock.id, call.caller);
      assert.equal(
        loser.events.reject.filter((event) => event.reason === "busy").length,
        1,
        "loser was not rejected"
      );
      assert.equal((await getState()).calls.length, 1);

      // Duplicate accept must not restart the call.
      c.sock.emit("call-accept", { to: winner.sock.id, callId: call.id });
      c.sock.emit("call-accept", { to: winner.sock.id, callId: call.id });
      await sleep(500);
      assert.equal(
        winner.events.accept.filter((event) => event.callId === call.id).length,
        1,
        "duplicate call-accept was forwarded"
      );

      // A third party cannot signal into this call.
      loser.sock.emit("signal", {
        to: c.sock.id,
        callId: call.id,
        data: { candidate: { candidate: "stale" } },
      });
      await sleep(400);
      assert.equal(c.events.signal.length, 0, "third-party signal forwarded");

      // A third party cannot chat into this call.
      loser.sock.emit("chat", { to: c.sock.id, text: "not allowed" });
      await sleep(400);
      assert.equal(c.events.chat.length, 0, "third-party chat forwarded");

      // The matched pair can chat before/while connecting.
      winner.sock.emit("chat", { to: c.sock.id, text: "hello" });
      await waitFor(() => c.events.chat.find((event) => event.text === "hello"), {
        label: "matched chat",
      });

      // Invalid callId is dropped.
      winner.sock.emit("signal", {
        to: c.sock.id,
        callId: "00000000-0000-0000-0000-000000000000",
        data: { candidate: { candidate: "bogus" } },
      });
      await sleep(300);
      assert.equal(c.events.signal.length, 0, "bogus callId forwarded");

      return { winner: winner.label, callee: c.label };
    });
  });

  await test("duplicate and simultaneous hangups are idempotent", async () => {
    return withClients(2, async ([a, b]) => {
      const { callId } = await createManualCall(a, b);

      a.sock.emit("call-hangup", { to: b.sock.id, callId });
      b.sock.emit("call-hangup", { to: a.sock.id, callId });
      a.sock.emit("call-hangup", { to: b.sock.id, callId });
      b.sock.emit("call-hangup", { to: a.sock.id, callId });

      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "call ended",
      });
      await sleep(600);

      assert.equal(a.events.hangup.length, 1, "a received duplicate hangup");
      assert.equal(b.events.hangup.length, 1, "b received duplicate hangup");
      const state = await getState();
      assert.equal(state.calls.length, 0);
      assert.equal(state.queueSize, 0, "manual users were requeued");
      return { callId };
    });
  });

  await test("peer disconnect releases the call", async () => {
    return withClients(2, async ([a, b]) => {
      await createManualCall(a, b);
      b.sock.close();
      await waitFor(
        () => a.events.hangup.find((event) => event.reason === "peer-disconnected"),
        { label: "disconnect hangup" }
      );
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "call released",
      });
      return { reason: "peer-disconnected" };
    });
  });

  await test("auto users requeue after partner disconnect and reconnect", async () => {
    return withClients(2, async (clients) => {
      const { call } = await pairAuto(clients);
      const [a, b] = clients;
      const partner = call.caller === a.sock.id ? a : b;
      const leaver = call.caller === a.sock.id ? b : a;

      leaver.sock.close();
      await waitFor(
        () => partner.events.hangup.find((event) => event.callId === call.id),
        { label: "partner hangup" }
      );

      const replacement = await connectClients(1, "re-");
      try {
        replacement[0].sock.emit("auto-call-start", {});
        const rematched = await waitFor(
          async () => {
            const state = await getState();
            if (state.calls.length !== 1) return null;
            const next = state.calls[0];
            const ids = [next.caller, next.callee];
            return ids.includes(partner.sock.id) &&
              ids.includes(replacement[0].sock.id) &&
              next.id !== call.id
              ? next
              : null;
          },
          { label: "auto rematch after reconnect", timeout: 12000 }
        );
        return { firstCall: call.id, secondCall: rematched.id };
      } finally {
        replacement[0].sock.close();
        partner.sock.close();
        await waitFor(async () => (await getState()).users.length === 0, {
          label: "all closed",
        });
      }
    });
  });

  await test("auto OFF is never requeued; auto ON partner is", async () => {
    return withClients(3, async (clients) => {
      const [a, b] = clients;
      const { call } = await pairAuto([a, b]);
      const caller = findClient([a, b], call.caller);
      const callee = findClient([a, b], call.callee);

      caller.sock.emit("auto-call-stop", {});
      await sleep(300);

      callee.sock.emit("call-hangup", { to: caller.sock.id, callId: call.id });
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "call ended",
      });
      await sleep(700);

      let state = await getState();
      assert.equal(state.calls.length, 0, "auto-off user was rematched");
      assert.equal(state.queueSize, 1, "auto-on partner was not requeued");
      const queuedUser = state.users.find((user) => user.autoActive);
      assert.ok(queuedUser, "no auto user in queue");
      assert.notEqual(queuedUser.id, caller.sock.id, "auto-off user was requeued");

      const third = clients[2];
      third.sock.emit("auto-call-start", {});
      await waitFor(
        async () => {
          const current = await getState();
          if (current.calls.length !== 1) return null;
          const ids = [current.calls[0].caller, current.calls[0].callee];
          return (
            ids.includes(queuedUser.id) &&
            ids.includes(third.sock.id) &&
            !ids.includes(caller.sock.id)
          );
        },
        { label: "auto partner matched with third user", timeout: 12000 }
      );
      return { autoOff: caller.label, requeued: queuedUser.id === callee.sock.id };
    });
  });

  await test("call timeout releases both users and allows a new call", async () => {
    return withClients(2, async ([a, b]) => {
      a.sock.emit("call-invite", { to: b.sock.id });
      const invite = await waitFor(() => b.events.invite[0], {
        label: "invite delivered",
      });

      await waitFor(
        () =>
          a.events.hangup.find(
            (event) => event.callId === invite.callId && event.reason === "timeout"
          ),
        { label: "caller timeout", timeout: CALL_TIMEOUT_MS + 6000 }
      );
      await waitFor(
        () =>
          b.events.hangup.find(
            (event) => event.callId === invite.callId && event.reason === "timeout"
          ),
        { label: "callee timeout", timeout: CALL_TIMEOUT_MS + 6000 }
      );
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "timeout cleanup",
      });

      // Both are free again: a fresh call must succeed.
      const second = await createManualCall(a, b);
      assert.notEqual(second.callId, invite.callId);
      a.sock.emit("call-hangup", { to: b.sock.id, callId: second.callId });
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "second call ended",
      });
      return { first: invite.callId, second: second.callId };
    });
  });

  await test("offline, busy and disabled incoming are rejected", async () => {
    return withClients(2, async ([a, b]) => {
      a.sock.emit("call-invite", { to: "missing-user-id" });
      await waitFor(
        () => a.events.reject.find((event) => event.reason === "offline"),
        { label: "offline reject" }
      );

      const { callId } = await createManualCall(a, b);
      const third = await connectClients(1, "x-");
      try {
        third[0].sock.emit("call-invite", { to: a.sock.id });
        await waitFor(
          () =>
            third[0].events.reject.find((event) => event.reason === "busy"),
          { label: "busy reject" }
        );
        assert.equal(
          third[0].events.reject.filter((event) => event.reason === "busy").length,
          1
        );
      } finally {
        third[0].sock.close();
      }

      a.sock.emit("call-hangup", { to: b.sock.id, callId });
      await waitFor(async () => (await getState()).calls.length === 0, {
        label: "cleanup",
      });
      return { offline: true, busy: true };
    });
  });

  await test("100 paired users hang up simultaneously without duplicate events", async () => {
    return withClients(
      100,
      async (clients) => {
        clients.forEach((client) => client.sock.emit("auto-call-start", {}));
        const state = await waitFor(
          async () => {
            const current = await getState();
            return current.calls.length === 50 ? current : null;
          },
          { label: "50 calls", timeout: 25000 }
        );

        // Turn Auto OFF so the mass hangup does not immediately rematch.
        clients.forEach((client) => client.sock.emit("auto-call-stop", {}));
        await sleep(400);

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
          label: "all calls ended",
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
        const after = await getState();
        assert.equal(after.queueSize, 0, "users were requeued despite Auto OFF");
        return { calls: state.calls.length, hangups: 100 };
      },
      "mass-"
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS),
    MATCH_INTERVAL_MS: "100",
    MATCH_COOLDOWN_MS: String(COOLDOWN_MS),
  };

  serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
    env,
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    failed.forEach((failure) => console.log(`  FAILED: ${failure.name} -> ${failure.error}`));
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
