// client/test/webrtc.e2e.js
//
// Real browser test: two Chrome pages with fake microphones connect through
// the actual signaling server, establish a real RTCPeerConnection, exchange
// audio, chat, hang up and rematch.
//
// Before running, build the client against the test server:
//   $env:VITE_SIGNALING_SERVER="http://127.0.0.1:3214"; npm run build
// Then:
//   node test/webrtc.e2e.js

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const SIGNAL_PORT = Number(process.env.E2E_SIGNAL_PORT || 3214);
const APP_PORT = Number(process.env.E2E_APP_PORT || 4174);
const SIGNAL_URL = `http://127.0.0.1:${SIGNAL_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const DIST = path.join(__dirname, "..", "dist");
const ARTIFACTS = path.join(__dirname, "artifacts");
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const serverLogs = [];
let serverProcess = null;
let staticServer = null;

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent((req.url || "/").split("?")[0]);
      } catch (e) {
        pathname = "/";
      }
      let file = path.join(DIST, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, "index.html");
      }
      res.writeHead(200, {
        "Content-Type": mimeType(file),
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(APP_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
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

async function state(url = SIGNAL_URL) {
  const response = await fetch(`${url}/debug/state`);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  return response.json();
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

async function openApp(browser, label, initScript) {
  const context = await browser.newContext({
    permissions: ["microphone"],
  });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForFunction(
    () => document.querySelector(".status-badge")?.innerText.includes("Connected"),
    null,
    { timeout: 25000 }
  );
  return { label, context, page, errors };
}

async function waitForCall(page, timeout = 30000) {
  await page.waitForSelector(".call-card", { state: "visible", timeout });
}

async function waitForIdle(page, timeout = 20000) {
  await page.waitForSelector(".call-card", { state: "detached", timeout });
}

async function clickAuto(page) {
  await page.locator("button", { hasText: "Auto Call" }).first().click();
}

async function clickStopAuto(page) {
  await page.locator("button", { hasText: "Stop Auto" }).first().click();
}

async function clickHangup(page) {
  await page.getByRole("button", { name: "Hang up" }).click();
}

async function audioStats(page) {
  return page.evaluate(() => {
    const element = document.querySelector("audio");
    const stream = element && element.srcObject;
    const tracks = stream ? stream.getAudioTracks() : [];
    return {
      hasStream: !!stream,
      tracks: tracks.length,
      trackState: tracks[0] ? tracks[0].readyState : null,
      trackMuted: tracks[0] ? tracks[0].muted : null,
      paused: element ? element.paused : null,
      readyState: element ? element.readyState : null,
      currentTime: element ? Number(element.currentTime.toFixed(3)) : null,
    };
  });
}

// A call can reach connectionState "connected" a few hundred milliseconds
// before the remote track is attached to the audio element, so wait for the
// real stream instead of sampling once.
async function waitForRemoteAudio(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const element = document.querySelector("audio");
      const stream = element && element.srcObject;
      const tracks = stream ? stream.getAudioTracks() : [];
      return tracks.length === 1 && tracks[0].readyState === "live";
    },
    null,
    { timeout }
  );
  return audioStats(page);
}

async function probeTurn(page) {
  return page.evaluate(async () => {
    const iceServers = window.__ANY_CALL_ICE || [];
    const log = [];
    const gather = (pc, tag) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.push(`${tag} gather timeout (${pc.iceGatheringState})`);
          resolve();
        }, 15000);
        const done = () => {
          clearTimeout(timer);
          log.push(`${tag} gathered`);
          resolve();
        };
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
          return;
        }
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") done();
        });
      });

    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "relay",
    });
    const candidates = [];
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        candidates.push({
          type: event.candidate.type,
          protocol: event.candidate.protocol,
        });
      }
    };
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    await gather(pc, "count-probe");
    const relay = candidates.filter((candidate) => candidate.type === "relay");
    pc.close();

    let connected = false;
    let connectionState = "not-run";
    if (relay.length > 0) {
      const pc1 = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
      const pc2 = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
      const dc = pc1.createDataChannel("relay-probe");
      const opened = new Promise((resolve) => {
        dc.onopen = () => resolve(true);
        setTimeout(() => resolve(false), 25000);
      });
      for (const [tag, peer] of [["pc1", pc1], ["pc2", pc2]]) {
        peer.oniceconnectionstatechange = () =>
          log.push(`${tag} ice=${peer.iceConnectionState}`);
        peer.onconnectionstatechange = () =>
          log.push(`${tag} conn=${peer.connectionState}`);
        peer.onicecandidateerror = (event) =>
          log.push(`${tag} ice-error ${event.errorCode} ${event.errorText}`);
      }
      await pc1.setLocalDescription(await pc1.createOffer());
      await gather(pc1, "pc1");
      await pc2.setRemoteDescription(pc1.localDescription);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await gather(pc2, "pc2");
      await pc1.setRemoteDescription(pc2.localDescription);
      log.push(`pc1 sdp candidates=${(pc1.remoteDescription?.sdp.match(/a=candidate/g) || []).length}`);

      const startedAt = Date.now();
      while (Date.now() - startedAt < 25000) {
        if (["connected", "failed"].includes(pc1.connectionState)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      connected = pc1.connectionState === "connected" || (await opened);
      connectionState = pc1.connectionState;
      pc1.close();
      pc2.close();
    }

    return {
      configuredServers: iceServers.length,
      candidates: candidates.length,
      relayCandidates: relay.length,
      relayConnected: connected,
      connectionState,
      sample: candidates.slice(0, 4),
      log,
    };
  });
}

const MIC_DENIED_SCRIPT = `
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true,
    value: () => Promise.reject(
      Object.assign(new Error("Permission denied by test"), { name: "NotAllowedError" })
    ),
  });
`;

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error("dist/index.html missing - run npm run build first");
  }
  const bundle = fs
    .readdirSync(path.join(DIST, "assets"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(path.join(DIST, "assets", file), "utf8"))
    .join("\n");
  assert.ok(
    bundle.includes(`127.0.0.1:${SIGNAL_PORT}`),
    `dist was not built for the test signaling URL. Set VITE_SIGNALING_SERVER=http://127.0.0.1:${SIGNAL_PORT} and rebuild.`
  );

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  staticServer = await startStaticServer();

  const env = {
    ...process.env,
    PORT: String(SIGNAL_PORT),
    NODE_ENV: "test",
    CALL_TIMEOUT_MS: "30000",
    MATCH_INTERVAL_MS: "100",
    MATCH_COOLDOWN_MS: "700",
  };
  delete env.REDIS_URL;

  serverProcess = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "server", "index.js")],
    {
      env,
      cwd: path.join(__dirname, "..", "..", "server"),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  serverProcess.stdout.on("data", (chunk) => serverLogs.push(chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => serverLogs.push(chunk.toString()));

  await waitFor(
    async () => {
      try {
        const response = await fetch(`${SIGNAL_URL}/health`);
        return response.ok;
      } catch (e) {
        return false;
      }
    },
    { label: "signaling server", timeout: 20000 }
  );

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  let a = null;
  let b = null;

  try {
    await test("two real browser peers connect with audio and chat", async () => {
      a = await openApp(browser, "peer-A");
      b = await openApp(browser, "peer-B");
      await Promise.all([clickAuto(a.page), clickAuto(b.page)]);
      await Promise.all([waitForCall(a.page), waitForCall(b.page)]);

      const stats1 = await Promise.all([
        waitForRemoteAudio(a.page),
        waitForRemoteAudio(b.page),
      ]);
      await sleep(1500);
      const stats2 = await Promise.all([audioStats(a.page), audioStats(b.page)]);

      for (const [index, stats] of stats2.entries()) {
        assert.ok(stats.hasStream, `peer ${index} has no remote stream`);
        assert.equal(stats.tracks, 1, `peer ${index} remote audio track count`);
        assert.equal(stats.trackState, "live", `peer ${index} track not live`);
        assert.equal(stats.trackMuted, false, `peer ${index} track muted`);
      }
      const progressed =
        stats2[0].currentTime > stats1[0].currentTime ||
        stats2[1].currentTime > stats1[1].currentTime;
      assert.ok(progressed, "remote audio playback did not advance");

      await a.page.waitForFunction(
        () => {
          const input = document.querySelector(".chat-input input");
          return input && !input.disabled;
        },
        null,
        { timeout: 20000 }
      );

      const messageA = `hello-from-A-${Date.now()}`;
      await a.page.locator(".chat-input input").fill(messageA);
      await a.page.locator(".chat-input input").press("Enter");
      await b.page.waitForFunction(
        (text) =>
          [...document.querySelectorAll(".message")].some((element) =>
            element.innerText.includes(text)
          ),
        messageA,
        { timeout: 20000 }
      );

      const messageB = `hello-from-B-${Date.now()}`;
      await b.page.locator(".chat-input input").fill(messageB);
      await b.page.locator(".chat-input input").press("Enter");
      await a.page.waitForFunction(
        (text) =>
          [...document.querySelectorAll(".message")].some((element) =>
            element.innerText.includes(text)
          ),
        messageB,
        { timeout: 20000 }
      );

      const callState = (await state()).calls[0];
      await a.page.screenshot({ path: path.join(ARTIFACTS, "connected-peer-A.png") });
      await b.page.screenshot({ path: path.join(ARTIFACTS, "connected-peer-B.png") });

      return {
        callId: callState.id,
        state: callState.state,
        audio: stats2,
        chat: "both directions",
      };
    });

    await test("hangup requeues Auto Call and peers reconnect", async () => {
      const firstCall = (await state()).calls[0];
      await clickHangup(a.page);
      await Promise.all([waitForIdle(a.page), waitForIdle(b.page)]);
      await Promise.all([waitForCall(a.page), waitForCall(b.page)]);

      const secondCall = await waitFor(
        async () => {
          const current = await state();
          return current.calls[0] && current.calls[0].id !== firstCall.id
            ? current.calls[0]
            : null;
        },
        { label: "second real call", timeout: 15000 }
      );

      // A new partner starts with an empty 1-to-1 chat box.
      const messages = await Promise.all([
        a.page.locator(".message").count(),
        b.page.locator(".message").count(),
      ]);
      assert.deepEqual(messages, [0, 0], "chat from the previous call leaked");

      return { firstCall: firstCall.id, secondCall: secondCall.id };
    });

    await test("simultaneous hangup leaves both peers idle", async () => {
      await Promise.all([clickStopAuto(a.page), clickStopAuto(b.page)]);
      await Promise.all([
        a.page
          .locator("button", { hasText: "Auto Call" })
          .first()
          .waitFor({ state: "visible", timeout: 10000 }),
        b.page
          .locator("button", { hasText: "Auto Call" })
          .first()
          .waitFor({ state: "visible", timeout: 10000 }),
      ]);
      await sleep(500);

      // Both hangups are dispatched from inside their pages so the two
      // events are genuinely simultaneous; a Playwright click would wait for
      // an element that the other peer's hangup may detach first.
      await Promise.all([
        a.page.evaluate(() => document.querySelector("button.hangup")?.click()),
        b.page.evaluate(() => document.querySelector("button.hangup")?.click()),
      ]);
      await Promise.all([waitForIdle(a.page), waitForIdle(b.page)]);
      await sleep(2500);
      const cards = await Promise.all([
        a.page.locator(".call-card").count(),
        b.page.locator(".call-card").count(),
      ]);
      assert.deepEqual(cards, [0, 0], "call reappeared after Auto was stopped");
      return { cards };
    });

    await test("browser refresh releases the call and requeues the partner", async () => {
      await Promise.all([clickAuto(a.page), clickAuto(b.page)]);
      await Promise.all([waitForCall(a.page), waitForCall(b.page)]);
      const before = (await state()).calls[0];

      await b.page.reload({ waitUntil: "load" });
      await b.page.waitForFunction(
        () => document.querySelector(".status-badge")?.innerText.includes("Connected"),
        null,
        { timeout: 25000 }
      );

      await waitForIdle(a.page);
      const after = await waitFor(
        async () => {
          const current = await state();
          return current.calls.length === 0 && current.queueSize === 1
            ? current
            : null;
        },
        { label: "refresh cleanup + partner requeue", timeout: 15000 }
      );

      await clickStopAuto(a.page);
      await waitFor(
        async () => {
          const current = await state();
          return current.queueSize === 0 ? current : null;
        },
        { label: "refresh test cleanup", timeout: 10000 }
      );

      return {
        callId: before.id,
        calls: after.calls.length,
        requeued: after.queueSize,
      };
    });

    await test("forced socket reconnect cleans up and rejoins Auto Call", async () => {
      await Promise.all([clickAuto(a.page), clickAuto(b.page)]);
      await Promise.all([waitForCall(a.page), waitForCall(b.page)]);
      const before = (await state()).calls[0];

      await b.page.evaluate(() => {
        window.__SIGNAL_SOCKET.io.engine.close();
      });

      await Promise.all([waitForCall(a.page), waitForCall(b.page)]);
      const after = await waitFor(
        async () => {
          const current = await state();
          return current.calls.length === 1 && current.calls[0].id !== before.id
            ? current.calls[0]
            : null;
        },
        { label: "rematch after reconnect", timeout: 20000 }
      );

      await Promise.all([clickStopAuto(a.page), clickStopAuto(b.page)]);
      await sleep(400);
      await Promise.all([
        a.page.evaluate(() => document.querySelector("button.hangup")?.click()),
        b.page.evaluate(() => document.querySelector("button.hangup")?.click()),
      ]);
      await Promise.all([waitForIdle(a.page), waitForIdle(b.page)]);

      return { firstCall: before.id, secondCall: after.id };
    });

    await test("microphone permission failure does not stick", async () => {
      await a.context.close();
      await b.context.close();
      a = null;
      b = null;
      await waitFor(async () => (await state()).users.length === 0, {
        label: "peers removed",
        timeout: 15000,
      });

      const denied = await openApp(browser, "peer-denied", MIC_DENIED_SCRIPT);
      const healthy = await openApp(browser, "peer-healthy");
      try {
        await clickAuto(denied.page);
        await clickAuto(healthy.page);

        await denied.page.waitForFunction(
          () => document.body.innerText.includes("Microphone permission is required"),
          null,
          { timeout: 25000 }
        );
        await sleep(2000);

        assert.equal(
          await healthy.page.locator(".call-card").count(),
          0,
          "healthy peer stayed in a call"
        );
        const deniedAuto = await denied.page
          .locator("button", { hasText: "Auto Call" })
          .count();
        assert.equal(deniedAuto, 1, "Auto Call stayed ON after mic failure");

        await waitFor(async () => (await state()).calls.length === 0, {
          label: "failed call released",
          timeout: 15000,
        });

        await denied.page.screenshot({
          path: path.join(ARTIFACTS, "microphone-denied.png"),
        });
        const healthyHasStop = await healthy.page
          .locator("button", { hasText: "Stop Auto" })
          .count();
        if (healthyHasStop) await clickStopAuto(healthy.page);
        return { notice: true, calls: 0 };
      } finally {
        await denied.context.close();
        await healthy.context.close();
        await waitFor(async () => (await state()).users.length === 0, {
          label: "mic test cleanup",
          timeout: 15000,
        });
      }
    });

    await test("TURN relay probe (reported honestly, not assumed)", async () => {
      const probePage = await browser.newPage();
      await probePage.goto(APP_URL, { waitUntil: "load" });
      try {
        const probe = await probeTurn(probePage);
        console.log(`      TURN probe: ${JSON.stringify(probe)}`);
        if (probe.relayCandidates === 0) {
          throw new Error(
            "no relay candidates: configured TURN is unreachable from this network"
          );
        }
        if (!probe.relayConnected) {
          throw new Error("relay candidates existed but relay-only call failed");
        }
        return probe;
      } finally {
        await probePage.close();
      }
    });

    for (const peer of [a, b]) {
      if (peer && peer.errors.length) {
        console.log(`      console errors on ${peer.label}: ${peer.errors.join(" | ")}`);
      }
    }
  } finally {
    if (a) await a.context.close().catch(() => {});
    if (b) await b.context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await sleep(300);
      serverProcess.kill("SIGKILL");
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log("\n===== SUMMARY =====");
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    failed.forEach((failure) =>
      console.log(`  FAILED: ${failure.name} -> ${failure.error}`)
    );
    console.log("\n--- signaling log tail ---");
    console.log(serverLogs.join("").split("\n").slice(-60).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ALL BROWSER TESTS PASSED");
  }
}

main().catch((err) => {
  console.error("TEST RUNNER ERROR:", err);
  console.log(serverLogs.join("").split("\n").slice(-60).join("\n"));
  if (staticServer) staticServer.close();
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
