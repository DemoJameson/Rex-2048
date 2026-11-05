const fs = require("node:fs");
const path = require("node:path");
const { SessionStore } = require("./sessions.cjs");
const { StreamManager } = require("./stream.cjs");
const { createApi, normalizePublicBaseUrl } = require("./api.cjs");
const { clearProgress } = require("./progress.cjs");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  } else {
    loadEnvFileFallback(envPath);
  }
}

const API_PORT = Number(process.env.API_PORT || 18081);
const API_BIND = process.env.API_BIND || "0.0.0.0";
const FLV_PORT = Number(process.env.FLV_PORT || 18080);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const FLV_BASE_URL =
  process.env.FLV_BASE_URL || `http://127.0.0.1:${FLV_PORT}`;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 128);
const MAX_ACTIVE_STREAMS = Number(
  process.env.MAX_ACTIVE_STREAMS || 16
);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const TRUST_PROXY = process.env.TRUST_PROXY || "";
const STREAM_IDLE_TIMEOUT_MS = Number(
  process.env.STREAM_IDLE_TIMEOUT_MS ||
    process.env.IDLE_TIMEOUT_MS ||
    30 * 60 * 1000
);
const SESSION_RETENTION_MS = Number(
  process.env.SESSION_RETENTION_MS || 30 * 24 * 60 * 60 * 1000
);
const SESSION_STORE_PATH =
  process.env.SESSION_STORE_PATH ||
  path.join(__dirname, "..", ".data", "sessions.json");

const sessions = new SessionStore({
  maxSessions: MAX_SESSIONS,
  dedupeWindowMs: 2000,
  persistPath: SESSION_STORE_PATH,
});

const streams = new StreamManager({
  getGame: (sessionId) => sessions.get(sessionId)?.game || null,
  rtmpPort: RTMP_PORT,
  httpPort: FLV_PORT,
  flvBaseUrl: FLV_BASE_URL,
  maxActiveStreams: MAX_ACTIVE_STREAMS,
  encoder: process.env.STREAM_ENCODER || "auto",
});

let apiServer = null;
let cleanupTimer = null;
let shuttingDown = false;

function loadEnvFileFallback(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    );
    if (!match || process.env[match[1]] != null) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function displayListenHost(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[rex2048] shutting down (${reason})`);

  if (cleanupTimer) clearInterval(cleanupTimer);
  sessions.save();
  try {
    await streams.stopAll();
  } catch (error) {
    console.error("[rex2048] stop streams failed:", error);
  }
  if (apiServer) {
    await new Promise((resolve) => {
      apiServer.close(resolve);
      apiServer.closeAllConnections?.();
    });
  }
  process.exit(0);
}

async function main() {
  const restored = sessions.load();
  if (restored > 0) {
    console.log(`[rex2048] restored ${restored} saved session(s)`);
  }
  const publicBaseUrl = normalizePublicBaseUrl(PUBLIC_BASE_URL);
  await streams.start();

  const app = createApi({
    sessions,
    streams,
    resetProgress: clearProgress,
    publicDir: path.join(__dirname, "public"),
    adminToken: ADMIN_TOKEN,
    publicBaseUrl,
    trustProxy: TRUST_PROXY,
  });

  const listenAddress = `http://${displayListenHost(API_BIND)}:${API_PORT}`;
  apiServer = app.listen(
    {
      port: API_PORT,
      host: API_BIND,
      ipv6Only: false,
    },
    () => {
      console.log(`[rex2048] API:      ${listenAddress}`);
      console.log(`[rex2048] Home:     ${listenAddress}/`);
      console.log(`[rex2048] Debug:    ${listenAddress}/debug`);
      console.log(
        `[rex2048] Public:   ${publicBaseUrl || "auto (request origin)"}`
      );
      console.log(`[rex2048] HTTP-FLV: ${FLV_BASE_URL}`);
      console.log(`[rex2048] RTMP:     rtmp://127.0.0.1:${RTMP_PORT}`);
      console.log(
        `[rex2048] Sessions: max=${MAX_SESSIONS} active=${MAX_ACTIVE_STREAMS} admin=${
          ADMIN_TOKEN ? "enabled" : "disabled"
        }`
      );
    }
  );

  apiServer.on("error", (error) => {
    console.error("[rex2048] API listen failed:", error);
    void shutdown("api-listen-error");
  });

  cleanupTimer = setInterval(() => {
    const idle = sessions.idleSessionIds(STREAM_IDLE_TIMEOUT_MS);
    for (const sessionId of idle) streams.stop(sessionId);
    const removed = sessions.cleanup(SESSION_RETENTION_MS);
    if (removed.length > 0) {
      console.log(`[rex2048] removed ${removed.length} expired session(s)`);
    }
  }, 60_000);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error) => {
  console.error("[rex2048] startup failed:", error);
  void shutdown("startup-error");
});
