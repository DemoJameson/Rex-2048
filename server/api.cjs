const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const express = require("express");
const cors = require("cors");
const { createCanvas } = require("@napi-rs/canvas");
const { serializeState } = require("./game.cjs");
const {
  SessionLimitError,
  SessionNotFoundError,
  isValidSessionId,
} = require("./sessions.cjs");
const {
  normalizeLanguage,
  episodeTitle,
  episodeDescription,
} = require("./i18n.cjs");

let posterCache = null;
const episodePosterCache = new Map();
const EPISODE_COLORS = {
  1: "#edc22e",
  2: "#5aa9e6",
  3: "#a78bfa",
  4: "#5ee0a0",
  5: "#f28c28",
  6: "#ffd166",
  7: "#ff7b9c",
};
const EPISODE_FONT =
  "'Noto Sans CJK SC', 'Hiragino Sans GB', 'Heiti SC', sans-serif";

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function buildPoster() {
  if (posterCache) return posterCache;

  const canvas = createCanvas(600, 900);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 600, 900);
  gradient.addColorStop(0, "#0b0e14");
  gradient.addColorStop(1, "#223044");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 600, 900);

  ctx.fillStyle = "#111722";
  roundedRect(ctx, 70, 210, 460, 460, 24);
  ctx.fill();

  const board = [
    [2048, 1024, 512, 256],
    [128, 64, 32, 16],
    [8, 4, 2, 0],
    [0, 0, 0, 0],
  ];
  const tileColors = {
    2: "#eee4da",
    4: "#ede0c8",
    8: "#f2b179",
    16: "#f59563",
    32: "#f67c5f",
    64: "#f65e3b",
    128: "#edcf72",
    256: "#edcc61",
    512: "#edc850",
    1024: "#edc53f",
    2048: "#edc22e",
  };
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = 90 + col * 108;
      const y = 230 + row * 108;
      const value = board[row][col];
      ctx.fillStyle = value ? tileColors[value] || "#3c3a32" : "#1a2330";
      roundedRect(ctx, x, y, 96, 96, 12);
      ctx.fill();

      if (!value) continue;

      const text = String(value);
      const fontSize = text.length <= 2 ? 44 : text.length === 3 ? 38 : 30;
      ctx.fillStyle =
        value === 2048 || value <= 4 ? "#2b2620" : "#ffffff";
      ctx.font = `800 ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + 48, y + 49);
    }
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 74px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Rex 2048", 300, 145);

  posterCache = canvas.toBuffer("image/png");
  return posterCache;
}

function drawEpisodeArrow(ctx, episode, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 18;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(160, 174);

  if (episode === 1) {
    ctx.font = `800 66px ${EPISODE_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("2048", 0, 4);
  } else if (episode === 6) {
    ctx.lineWidth = 16;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.translate(4, 0);

    // Left/bottom half of the loop, ending in a right-pointing arrow.
    ctx.beginPath();
    ctx.moveTo(12, -60);
    ctx.lineTo(-42, -60);
    ctx.quadraticCurveTo(-60, -60, -60, -42);
    ctx.lineTo(-60, 42);
    ctx.quadraticCurveTo(-60, 60, -42, 60);
    ctx.lineTo(-12, 60);
    ctx.stroke();

    // Right/top half of the loop, ending in a left-pointing arrow.
    ctx.beginPath();
    ctx.moveTo(12, 60);
    ctx.lineTo(42, 60);
    ctx.quadraticCurveTo(60, 60, 60, 42);
    ctx.lineTo(60, -42);
    ctx.quadraticCurveTo(60, -60, 42, -60);
    ctx.lineTo(12, -60);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-20, 36);
    ctx.lineTo(20, 60);
    ctx.lineTo(-20, 84);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(20, -84);
    ctx.lineTo(-20, -60);
    ctx.lineTo(20, -36);
    ctx.closePath();
    ctx.fill();
  } else if (episode === 7) {
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.translate(4, -2);

    ctx.beginPath();
    ctx.moveTo(-32, -30);
    ctx.lineTo(22, -30);
    ctx.quadraticCurveTo(54, -30, 54, 2);
    ctx.lineTo(54, 30);
    ctx.quadraticCurveTo(54, 62, 22, 62);
    ctx.lineTo(-8, 62);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-32, -58);
    ctx.lineTo(-62, -30);
    ctx.lineTo(-32, -2);
    ctx.stroke();
  } else {
    const rotation = { 2: 0, 3: Math.PI, 4: -Math.PI / 2, 5: Math.PI / 2 }[
      episode
    ];
    ctx.rotate(rotation);
    ctx.beginPath();
    ctx.moveTo(0, 60);
    ctx.lineTo(0, -48);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -82);
    ctx.lineTo(-34, -42);
    ctx.lineTo(34, -42);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function wrapCanvasText(ctx, text, maxWidth) {
  const hasSpaces = /\s/.test(text);
  const tokens = hasSpaces ? text.split(/\s+/) : Array.from(text);
  const joiner = hasSpaces ? " " : "";
  const lines = [];
  let line = "";

  for (const token of tokens) {
    const candidate = line ? `${line}${joiner}${token}` : token;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = token;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildEpisodePoster(episodeNumber, language) {
  const key = `${episodeNumber}:${language}`;
  const cached = episodePosterCache.get(key);
  if (cached) return cached;

  const canvas = createCanvas(640, 360);
  const ctx = canvas.getContext("2d");
  const accent = EPISODE_COLORS[episodeNumber] || "#edc22e";

  const background = ctx.createLinearGradient(0, 0, 640, 360);
  background.addColorStop(0, "#0b0e14");
  background.addColorStop(1, "#1a2230");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 640, 360);

  ctx.fillStyle = "#111722";
  roundedRect(ctx, 48, 62, 224, 224, 22);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  roundedRect(ctx, 48, 62, 224, 224, 22);
  ctx.stroke();
  drawEpisodeArrow(ctx, episodeNumber, accent);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const title = episodeTitle(episodeNumber, language);
  let titleSize = 50;
  ctx.font = `800 ${titleSize}px ${EPISODE_FONT}`;
  while (titleSize > 30 && ctx.measureText(title).width > 300) {
    titleSize -= 2;
    ctx.font = `800 ${titleSize}px ${EPISODE_FONT}`;
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillText(title, 318, 62);

  const description = episodeDescription(episodeNumber, language);
  let descriptionSize = 26;
  let descriptionLines = [];
  do {
    ctx.font = `700 ${descriptionSize}px ${EPISODE_FONT}`;
    descriptionLines = wrapCanvasText(ctx, description, 300);
    if (descriptionLines.length <= 2) break;
    descriptionSize -= 2;
  } while (descriptionSize >= 20);

  ctx.fillStyle = "#dbe4f0";
  const descriptionLineHeight = Math.round(descriptionSize * 1.3);
  descriptionLines.slice(0, 2).forEach((line, index) => {
    ctx.fillText(line, 318, 140 + index * descriptionLineHeight);
  });

  ctx.fillStyle = accent;
  ctx.font = `800 20px ${EPISODE_FONT}`;
  ctx.fillText("REX 2048", 318, 270);

  const buffer = canvas.toBuffer("image/png");
  episodePosterCache.set(key, buffer);
  return buffer;
}

function statusForError(error) {
  if (error && Number.isInteger(error.statusCode)) return error.statusCode;
  const message = String(error?.message || "");
  if (message.includes("非法") || message.includes("格式无效")) return 400;
  if (message.includes("超时") || message.includes("视频流")) return 503;
  return 500;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error(
      "PUBLIC_BASE_URL 必须是有效的 http:// 或 https:// 地址"
    );
  }

  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(
      "PUBLIC_BASE_URL 只能是 http(s)://host[:port]，不能包含路径、查询或凭据"
    );
  }
  return parsed.origin;
}

function parseTrustProxy(value) {
  if (value === true || value === false) return value;
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function requestOrigin(req, publicBaseUrl, trustProxy) {
  if (publicBaseUrl) return publicBaseUrl;

  let host = req.get("host") || "";
  if (trustProxy && req.protocol === "https") {
    const forwardedHost = String(req.get("x-forwarded-host") || "")
      .split(",")[0]
      .trim();
    if (forwardedHost) host = forwardedHost;
  }

  const protocol = req.protocol === "https" ? "https" : "http";
  try {
    const parsed = new URL(`${protocol}://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new Error("invalid host");
    }
    return parsed.origin;
  } catch (_error) {
    throw new Error("无法确定公开访问地址，请设置 PUBLIC_BASE_URL");
  }
}

function publicStreamUrl(
  req,
  sessionId,
  nonce,
  publicBaseUrl,
  trustProxy
) {
  const value = nonce || Date.now().toString(36);
  return `${requestOrigin(
    req,
    publicBaseUrl,
    trustProxy
  )}/stream/${encodeURIComponent(
    sessionId
  )}/${encodeURIComponent(value)}.flv`;
}

function createApi(options = {}) {
  const sessions = options.sessions;
  const streams = options.streams;
  const publicDir = options.publicDir || path.join(__dirname, "public");
  const modulePath =
    options.modulePath || path.join(__dirname, "..", "dist", "index.js");
  const resetProgress =
    options.resetProgress || (async () => ({ cleared: false, reason: "disabled" }));
  const adminToken = String(
    options.adminToken != null
      ? options.adminToken
      : process.env.ADMIN_TOKEN || ""
  );
  const publicBaseUrl = normalizePublicBaseUrl(
    options.publicBaseUrl != null
      ? options.publicBaseUrl
      : process.env.PUBLIC_BASE_URL
  );
  const trustProxy = parseTrustProxy(
    options.trustProxy != null
      ? options.trustProxy
      : process.env.TRUST_PROXY
  );
  const adminEnabled = adminToken.length > 0;
  const providedAdminToken = (req) => {
    const header = req.get("x-admin-token");
    if (header) return header;
    const authorization = req.get("authorization") || "";
    if (/^Bearer\s+/i.test(authorization)) {
      return authorization.replace(/^Bearer\s+/i, "");
    }
    return String(req.query?.token || "");
  };
  const hasAdminToken = (req) =>
    adminEnabled && safeEqual(providedAdminToken(req), adminToken);
  const requireAdmin = (req, res, next) => {
    if (!adminEnabled) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    if (!hasAdminToken(req)) {
      res.status(401).json({ ok: false, error: "管理员 token 无效" });
      return;
    }
    next();
  };
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use(cors());
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("CDN-Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  const publicStreamUrlFor = (req, sessionId, nonce) =>
    publicStreamUrl(req, sessionId, nonce, publicBaseUrl, trustProxy);

  app.get("/api/health", (req, res) => {
    const health = streams.health();
    const ok = Boolean(health.ffmpeg && health.nms);
    const payload = {
      ok,
      ffmpeg: health.ffmpeg,
      nms: health.nms,
      encoder: health.encoder,
      encoderRequested: health.encoderRequested,
      maxActiveStreams: health.maxActiveStreams,
      capacityWarning: health.capacityWarning,
      video: health.video,
      audio: health.audio,
      limits: health.limits,
      activeStreams: health.activeStreams,
      api: true,
      publicBaseUrl: publicBaseUrl || null,
    };
    if (hasAdminToken(req)) payload.streams = health.streams;
    res.status(ok ? 200 : 503).json(payload);
  });

  app.get("/api/sessions", requireAdmin, (req, res) => {
    res.json({
      ok: true,
      sessions: sessions.list().map((session) => ({
        ...session,
        streamUrl: publicStreamUrlFor(req, session.sessionId),
      })),
      health: streams.health(),
    });
  });

  app.get("/api/sessions/:sessionId", requireAdmin, (req, res, next) => {
    try {
      const session = sessions.get(req.params.sessionId);
      if (!session) throw new SessionNotFoundError("会话不存在");
      res.json({
        ok: true,
        ...sessions.serialize(session),
        streamUrl: publicStreamUrlFor(req, session.id),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:sessionId/prepare", async (req, res, next) => {
    const sessionId = String(req.params.sessionId || "");
    try {
      if (!isValidSessionId(sessionId)) {
        const error = new Error("sessionId 格式无效");
        error.statusCode = 400;
        throw error;
      }
      const language = normalizeLanguage(req.body?.language);
      sessions.getOrCreate(sessionId, language);
      sessions.setLanguage(sessionId, language);
      const startedAt = Date.now();
      await streams.ensureStream(sessionId);
      res.json({
        ok: true,
        prepared: true,
        streamUrl: publicStreamUrlFor(req, sessionId),
        timings: {
          streamReadyMs: Date.now() - startedAt,
          totalMs: Date.now() - startedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:sessionId/command", async (req, res, next) => {
    const sessionId = String(req.params.sessionId || "");
    const episode = Number(req.body?.episode);
    const commandId = String(req.body?.commandId || "");

    try {
      if (!isValidSessionId(sessionId)) {
        const error = new Error("sessionId 格式无效");
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isInteger(episode) || episode < 1 || episode > 7) {
        const error = new Error("非法选集");
        error.statusCode = 400;
        throw error;
      }

      const language = normalizeLanguage(req.body?.language);
      sessions.getOrCreate(sessionId, language);
      const progressLink = String(req.body?.progressLink || "");
      let progress = null;
      if (progressLink) {
        try {
          progress = await resetProgress({
            link: progressLink,
            episode,
            sessionId,
          });
        } catch (error) {
          progress = { cleared: false, reason: error.message };
          console.warn("[rex2048] reset progress failed:", error);
        }
      }

      const snapshot = sessions.snapshot(sessionId);
      sessions.setLanguage(sessionId, language);
      try {
        const commandStartedAt = Date.now();
        const result = sessions.applyCommand(sessionId, episode, commandId);
        const commandMs = Date.now() - commandStartedAt;
        if (result.applied && result.session.game.animation) {
          sessions.holdAnimation(sessionId);
        }

        const streamStartedAt = Date.now();
        await streams.ensureStream(sessionId, { fresh: true });
        if (result.applied && result.session.game.animation) {
          sessions.deferAnimation(sessionId, 0);
        }
        const streamReadyMs = Date.now() - streamStartedAt;

        res.json({
          ok: true,
          applied: result.applied,
          duplicate: result.duplicate,
          command: result.command,
          streamUrl: publicStreamUrlFor(req, sessionId, commandId),
          state: serializeState(result.session.game),
          recentCommands: result.session.recentCommands.slice(-20),
          progress,
          timings: {
            commandMs,
            streamReadyMs,
            totalMs: commandMs + streamReadyMs,
          },
        });
      } catch (error) {
        sessions.restore(sessionId, snapshot);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:sessionId/resume", async (req, res, next) => {
    const sessionId = String(req.params.sessionId || "");
    const episode = Number(req.body?.episode);

    try {
      if (!isValidSessionId(sessionId)) {
        const error = new Error("sessionId 格式无效");
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isInteger(episode) || episode < 1 || episode > 7) {
        const error = new Error("非法选集");
        error.statusCode = 400;
        throw error;
      }

      const language = normalizeLanguage(req.body?.language);
      sessions.getOrCreate(sessionId, language);
      sessions.setLanguage(sessionId, language);

      const progressLink = String(req.body?.progressLink || "");
      let progress = null;
      if (progressLink) {
        try {
          progress = await resetProgress({
            link: progressLink,
            episode,
            sessionId,
          });
        } catch (error) {
          progress = { cleared: false, reason: error.message };
          console.warn("[rex2048] reset resume progress failed:", error);
        }
      }

      const streamStartedAt = Date.now();
      await streams.ensureStream(sessionId);
      const session = sessions.get(sessionId);
      res.json({
        ok: true,
        resumed: true,
        streamUrl: publicStreamUrlFor(req, sessionId),
        state: serializeState(session.game),
        language,
        progress,
        timings: {
          streamReadyMs: Date.now() - streamStartedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/stream/:sessionId/:nonce.flv", (req, res, next) => {
    const sessionId = String(req.params.sessionId || "");
    if (!isValidSessionId(sessionId)) {
      const error = new Error("sessionId 格式无效");
      error.statusCode = 400;
      next(error);
      return;
    }

    const upstream = new URL(streams.streamUrl(sessionId));
    const proxy = http.get(upstream, (upstreamResponse) => {
      if (upstreamResponse.statusCode !== 200) {
        upstreamResponse.resume();
        const error = new Error(
          `视频流暂不可用：HTTP ${upstreamResponse.statusCode || "unknown"}`
        );
        error.statusCode = 502;
        next(error);
        return;
      }

      res.status(200);
      res.setHeader("Content-Type", "video/x-flv");
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("CDN-Cache-Control", "no-store");
      res.setHeader("Surrogate-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true);
      }
      res.flushHeaders();
      upstreamResponse.once("error", (error) => {
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      upstreamResponse.pipe(res);
    });

    proxy.once("error", (error) => {
      if (!res.headersSent) next(error);
      else res.destroy(error);
    });
    res.once("close", () => proxy.destroy());
  });

  app.get("/api/sessions/:sessionId/play", async (req, res, next) => {
    const sessionId = String(req.params.sessionId || "");
    const episode = Number(req.query.episode);
    const nonce = String(req.query.nonce || "").trim();
    const progressLink = String(req.query.link || "");

    try {
      if (!isValidSessionId(sessionId)) {
        const error = new Error("sessionId 格式无效");
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isInteger(episode) || episode < 1 || episode > 7) {
        const error = new Error("非法选集");
        error.statusCode = 400;
        throw error;
      }
      if (nonce && !/^[A-Za-z0-9_-]{4,64}$/.test(nonce)) {
        const error = new Error("nonce 格式无效");
        error.statusCode = 400;
        throw error;
      }

      const language = normalizeLanguage(req.query.lang || req.query.language);
      sessions.getOrCreate(sessionId, language);
      const snapshot = sessions.snapshot(sessionId);
      sessions.setLanguage(sessionId, language);
      if (progressLink) {
        try {
          await resetProgress({
            link: progressLink,
            episode,
            sessionId,
          });
        } catch (error) {
          console.warn("[rex2048] reset play progress failed:", error);
        }
      }
      try {
        const commandId = nonce
          ? `play:${episode}:${nonce}`
          : `fallback:${episode}:${Math.floor(Date.now() / 2000)}`;
        const result = sessions.applyCommand(
          sessionId,
          episode,
          commandId
        );
        if (result.applied && result.session.game.animation) {
          sessions.holdAnimation(sessionId);
        }
        await streams.ensureStream(sessionId, { fresh: true });
        if (result.applied && result.session.game.animation) {
          sessions.deferAnimation(sessionId, 0);
        }
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");
        res.set("Pragma", "no-cache");
        res.redirect(
          302,
          publicStreamUrlFor(
            req,
            sessionId,
            nonce || Date.now().toString(36)
          )
        );
      } catch (error) {
        sessions.restore(sessionId, snapshot);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/assets/poster.png", (_req, res) => {
    res
      .type("png")
      .set("Cache-Control", "public, max-age=3600")
      .send(buildPoster());
  });

  app.get("/assets/episode/:episode.png", (req, res, next) => {
    const episode = Number(req.params.episode);
    if (!Number.isInteger(episode) || episode < 1 || episode > 7) {
      const error = new Error("非法选集");
      error.statusCode = 400;
      next(error);
      return;
    }
    const language = normalizeLanguage(req.query.lang || req.query.language);
    res
      .type("png")
      .set("Cache-Control", "public, max-age=3600")
      .send(buildEpisodePoster(episode, language));
  });

  app.get("/module/rex-2048.js", async (req, res, next) => {
    try {
      const source = await fs.promises.readFile(modulePath, "utf8");
      const moduleSource = source.replace(
        /["']__REX2048_DEFAULT_SERVER__["']/g,
        () =>
          JSON.stringify(
            requestOrigin(req, publicBaseUrl, trustProxy)
          )
      );
      res
        .type("application/javascript")
        .set("Cache-Control", "no-cache, no-store, must-revalidate")
        .set("Pragma", "no-cache")
        .set("X-Content-Type-Options", "nosniff")
        .send(moduleSource);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        res.status(404).json({
          ok: false,
          error: "模块尚未构建，请先在项目目录运行 npm run build",
        });
        return;
      }
      next(error);
    }
  });

  app.get("/debug", requireAdmin, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.use("/debug", express.static(publicDir));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "home.html"));
  });

  app.get("/favicon.svg", (_req, res) => {
    res.sendFile(path.join(publicDir, "favicon.svg"));
  });

  app.use((error, _req, res, _next) => {
    const status = statusForError(error);
    res.status(status).json({
      ok: false,
      error: error.message || "服务端错误",
    });
  });

  return app;
}

module.exports = {
  createApi,
  buildPoster,
  normalizePublicBaseUrl,
};
