const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_PORT = 18181;
const FLV_PORT = 18180;
const RTMP_PORT = 1936;
const BASE = `http://127.0.0.1:${API_PORT}`;
const serverPath = path.join(__dirname, "..", "server", "index.cjs");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch (_error) {
      // Server is still starting.
    }
    await wait(250);
  }
  throw new Error("server health check timed out");
}

async function waitForNoStreams(timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetch(`${BASE}/api/health`).then((response) =>
      response.json()
    );
    if (health.activeStreams === 0) return;
    await wait(250);
  }
  throw new Error("stream did not stop in time");
}

function runFfmpeg(url) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "info", "-i", url, "-t", "2", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function captureFlv(url, seconds, filePath) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        url,
        "-t",
        String(seconds),
        "-c",
        "copy",
        filePath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch (_error) {
        size = 0;
      }
      resolve({ code, output, size });
    });
  });
}

function probePacketEnds(filePath) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "packet=codec_type,dts_time",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function packetEnds(output) {
  let video = 0;
  let audio = 0;
  for (const line of output.trim().split("\n")) {
    const [type, value] = line.split(",");
    const time = Number(value);
    if (!Number.isFinite(time)) continue;
    if (type === "video") video = Math.max(video, time);
    if (type === "audio") audio = Math.max(audio, time);
  }
  return { video, audio };
}

(async () => {
  const storeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rex2048-stream-")
  );
  const storePath = path.join(storeDirectory, "sessions.json");
  const server = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      FLV_PORT: String(FLV_PORT),
      RTMP_PORT: String(RTMP_PORT),
      FLV_BASE_URL: `http://127.0.0.1:${FLV_PORT}`,
      MAX_SESSIONS: "1",
      IDLE_TIMEOUT_MS: "60000",
      SESSION_STORE_PATH: storePath,
      STREAM_FPS: "30",
      STREAM_ENCODER: "libx264",
      STREAM_BITRATE: "2M",
      STREAM_MAXRATE: "2500k",
      STREAM_BUFSIZE: "2500k",
      STREAM_GOP: "0",
      STREAM_UNVIEWED_TIMEOUT_MS: "2000",
      STREAM_VIEWER_IDLE_GRACE_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

  try {
    const health = await waitForHealth();
    assert.equal(health.video.fps, 30);
    assert.equal(health.encoder, "libx264");
    assert.equal(health.maxActiveStreams, 16);
    assert.equal(health.video.bitrate, "2M");
    assert.equal(health.video.gop, 30);
    assert.equal(health.audio.sampleRate, 48000);
    assert.equal(health.audio.bitrate, "64k");
    assert.equal(health.limits.unviewedTimeoutMs, 2000);
    assert.equal(health.limits.viewerIdleGraceMs, 2000);
    const command = await fetch(
      `${BASE}/api/sessions/smoke-session-01/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 1,
          commandId: "smoke:smoke-session-01:1:1",
        }),
      }
    ).then((response) => response.json());
    assert.equal(command.ok, true);
    assert.ok(command.streamUrl);

    const capturePath = path.join(storeDirectory, "capture.flv");
    const capture = await captureFlv(command.streamUrl, 3, capturePath);
    assert.equal(capture.code, 0, capture.output);
    assert.ok(capture.size > 0);
    assert.ok(
      capture.size < 1_500_000,
      `3s capture too large: ${capture.size} bytes`
    );
    const packetProbe = await probePacketEnds(capturePath);
    assert.equal(packetProbe.code, 0);
    const ends = packetEnds(packetProbe.output);
    assert.ok(ends.video > 0);
    assert.ok(ends.audio > 0);
    assert.ok(
      Math.abs(ends.video - ends.audio) < 0.25,
      `A/V drift: video=${ends.video}s audio=${ends.audio}s`
    );

    const probe = await runFfmpeg(command.streamUrl);
    assert.equal(probe.code, 0, probe.output);
    assert.match(probe.output, /Video:\s*h264/i);
    assert.match(probe.output, /Audio:\s*aac/i);
    assert.match(probe.output, /1280x720/);
    assert.match(probe.output, /30(?:\.\d+)?\s*fps|30\s*tbr/i);

    await waitForNoStreams(6000);

    const unviewed = await fetch(
      `${BASE}/api/sessions/smoke-session-01/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 2,
          commandId: "smoke:smoke-session-01:2:1",
        }),
      }
    ).then((response) => response.json());
    assert.equal(unviewed.ok, true);
    assert.ok(unviewed.streamUrl);
    await waitForNoStreams(6000);

    console.log("stream smoke passed:", command.streamUrl);
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (server.exitCode && server.exitCode !== 0) {
      console.error(serverLog);
    }
    fs.rmSync(storeDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
