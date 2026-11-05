const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const NodeMediaServer = require("node-media-server");
const { createRenderer } = require("./render.cjs");
const { GameAudio, SAMPLE_RATE } = require("./audio.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durationOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function streamKeyForSession(sessionId, generation = "base") {
  return crypto
    .createHash("sha256")
    .update(`${String(sessionId)}:${String(generation)}`)
    .digest("hex")
    .slice(0, 24);
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function detectEncoders() {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-encoders"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", () => resolve(new Set()));
    child.once("exit", () => {
      const encoders = new Set();
      for (const line of output.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && /^[VAS]/.test(parts[0])) {
          encoders.add(parts[1]);
        }
      }
      resolve(encoders);
    });
  });
}

function chooseEncoder(requested, available, options = {}) {
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const env = options.env || process.env;
  const wanted = String(requested || "auto").toLowerCase();

  if (wanted !== "auto") {
    if (available.has(wanted)) return wanted;
    return available.has("libx264") ? "libx264" : null;
  }
  if (platform === "darwin" && available.has("h264_videotoolbox")) {
    return "h264_videotoolbox";
  }
  if (
    available.has("h264_nvenc") &&
    (exists("/dev/nvidia0") || env.NVIDIA_VISIBLE_DEVICES)
  ) {
    return "h264_nvenc";
  }
  if (
    available.has("h264_vaapi") &&
    exists(env.VAAPI_DEVICE || "/dev/dri/renderD128")
  ) {
    return "h264_vaapi";
  }
  if (available.has("libx264")) return "libx264";
  if (available.has("h264_videotoolbox")) return "h264_videotoolbox";
  return null;
}

function videoEncoderArgs(encoder, settings = {}) {
  const gop = Number(settings.gop || 30);
  const bitrate = String(settings.bitrate || "2M");
  const maxrate = String(settings.maxrate || "2500k");
  const bufsize = String(settings.bufsize || "2500k");
  const common = [
    "-profile:v",
    "high",
    "-level",
    "4.2",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-sc_threshold",
    "0",
    "-b:v",
    bitrate,
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
  ];

  if (encoder === "h264_nvenc") {
    return [
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p4",
      "-tune",
      "ll",
      "-rc",
      "cbr",
      "-pix_fmt",
      "yuv420p",
      ...common,
    ];
  }
  if (encoder === "h264_vaapi") {
    return [
      "-vaapi_device",
      settings.vaapiDevice || "/dev/dri/renderD128",
      "-vf",
      "format=nv12,hwupload",
      "-c:v",
      "h264_vaapi",
      ...common,
    ];
  }
  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v",
      "h264_videotoolbox",
      "-realtime",
      "1",
      "-allow_sw",
      "1",
      "-prio_speed",
      "1",
      "-pix_fmt",
      "yuv420p",
      ...common,
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    ...common,
  ];
}

function renderStateForGame(game) {
  return game
    ? {
        board: game.board,
        score: game.score,
        moveCount: game.moveCount,
        best: game.best,
        over: game.over,
        won: game.won,
        commandSeq: game.commandSeq,
        lastCommand: game.lastCommand,
        cheatAt: game.cheatAt,
        cheatEnding: game.cheatEnding,
        language: game.language,
        animation: game.animation,
      }
    : {
        board: Array.from({ length: 4 }, () => Array(4).fill(0)),
        score: 0,
        moveCount: 0,
        best: 0,
        over: false,
        won: false,
        commandSeq: 0,
        lastCommand: "new",
        cheatAt: 0,
        cheatEnding: false,
        language: "zh-Hans",
        animation: null,
      };
}

class StreamManager {
  constructor(options = {}) {
    this.getGame = options.getGame || (() => null);
    this.rtmpPort = Number(options.rtmpPort || 1935);
    this.httpPort = Number(options.httpPort || 18080);
    this.bind = options.bind || "127.0.0.1";
    const requestedMaxActive = Number(
      options.maxActiveStreams || process.env.MAX_ACTIVE_STREAMS || 16
    );
    this.maxActiveStreams =
      Number.isFinite(requestedMaxActive) && requestedMaxActive > 0
        ? Math.floor(requestedMaxActive)
        : 16;
    this.requestedEncoder = String(
      options.encoder || process.env.STREAM_ENCODER || "auto"
    ).toLowerCase();
    this.encoder = "libx264";
    this.encoderAvailable = new Set();
    this.vaapiDevice =
      process.env.VAAPI_DEVICE || "/dev/dri/renderD128";
    this.capacityWarning = "";
    this.flvBaseUrl = String(
      options.flvBaseUrl || `http://127.0.0.1:${this.httpPort}`
    ).replace(/\/+$/, "");
    this.width = Number(options.width || 1280);
    this.height = Number(options.height || 720);
    const requestedFps = Number(
      options.fps || process.env.STREAM_FPS || 30
    );
    this.fps = Number.isFinite(requestedFps)
      ? Math.max(30, requestedFps)
      : 30;
    this.bitrate = String(
      options.bitrate || process.env.STREAM_BITRATE || "2M"
    );
    this.maxrate = String(
      options.maxrate || process.env.STREAM_MAXRATE || "2500k"
    );
    this.bufsize = String(
      options.bufsize || process.env.STREAM_BUFSIZE || "2500k"
    );
    const requestedGop = Number(
      options.gop || process.env.STREAM_GOP || 30
    );
    this.gop = Number.isFinite(requestedGop)
      ? Math.max(30, requestedGop)
      : 30;
    this.unviewedTimeoutMs = durationOption(
      options.unviewedTimeoutMs ?? process.env.STREAM_UNVIEWED_TIMEOUT_MS,
      30000
    );
    this.viewerIdleGraceMs = durationOption(
      options.viewerIdleGraceMs ?? process.env.STREAM_VIEWER_IDLE_GRACE_MS,
      5000
    );
    this.streamVersion = Date.now().toString(36);
    this.entries = new Map();
    this.pendingStops = new Set();
    this.nms = null;
    this.running = false;
    this.ffmpegAvailable = false;
  }

  async start() {
    this.ffmpegAvailable = await checkFfmpeg();
    if (!this.ffmpegAvailable) {
      throw new Error("找不到可用的 ffmpeg");
    }
    this.encoderAvailable = await detectEncoders();
    this.encoder = chooseEncoder(
      this.requestedEncoder,
      this.encoderAvailable,
      { env: { ...process.env, VAAPI_DEVICE: this.vaapiDevice } }
    );
    if (!this.encoder) {
      throw new Error("FFmpeg 没有可用的 H.264 编码器");
    }
    if (this.requestedEncoder !== "auto" && this.encoder !== this.requestedEncoder) {
      console.warn(
        `[rex2048] encoder ${this.requestedEncoder} unavailable, fallback=${this.encoder}`
      );
    }
    if (this.encoder === "libx264" && this.maxActiveStreams > 4) {
      this.capacityWarning = `libx264 软件编码下 ${this.maxActiveStreams} 路 720p${this.fps} 可能超出宿主机 CPU 能力`;
      console.warn(`[rex2048] ${this.capacityWarning}`);
    }
    console.log(
      `[rex2048] encoder=${this.encoder} maxActiveStreams=${this.maxActiveStreams}`
    );

    this.nms = new NodeMediaServer({
      bind: this.bind,
      rtmp: { port: this.rtmpPort },
      http: { port: this.httpPort },
      webadmin: { enable: false },
      record: { auto: false },
      auth: { play: false, publish: false },
      store: {
        path: path.join(os.tmpdir(), "rex-2048-nms"),
      },
    });

    this.nms.on("postPublish", (session) => {
      const entry = this.entryForStream(session);
      if (!entry) return;
      entry.published = true;
      entry.ready = false;
      this.armUnviewedTimer(entry);
      entry.publishWaiters.splice(0).forEach((waiter) => {
        clearTimeout(waiter.timer);
        waiter.resolve();
      });
    });

    this.nms.on("donePublish", (session) => {
      const entry = this.entryForStream(session);
      if (!entry) return;
      this.clearEntryTimers(entry);
      entry.viewers = 0;
      entry.published = false;
      entry.ready = false;
      entry.readyPromise = null;
    });

    this.nms.on("postPlay", (session) => {
      const entry = this.entryForStream(session);
      if (entry) this.handlePostPlay(entry);
    });

    this.nms.on("donePlay", (session) => {
      const entry = this.entryForStream(session);
      if (entry) this.handleDonePlay(entry);
    });

    await this.nms.run();
    this.running = true;
  }

  streamKey(sessionId, generation = "base") {
    return streamKeyForSession(sessionId, generation);
  }

  entryForStream(session) {
    const key = String(session.streamPath || "").split("/").pop();
    return this.entries.get(key) || null;
  }

  clearEntryTimers(entry) {
    for (const name of ["unviewedTimer", "idleTimer"]) {
      if (!entry[name]) continue;
      clearTimeout(entry[name]);
      entry[name] = null;
    }
  }

  armUnviewedTimer(entry) {
    if (this.unviewedTimeoutMs <= 0) return;
    if (entry.unviewedTimer) clearTimeout(entry.unviewedTimer);
    entry.unviewedTimer = setTimeout(() => {
      entry.unviewedTimer = null;
      if (entry.viewers === 0) void this.stopEntry(entry);
    }, this.unviewedTimeoutMs);
  }

  handlePostPlay(entry) {
    entry.viewers += 1;
    entry.audio?.markViewerConnected();
    if (entry.unviewedTimer) {
      clearTimeout(entry.unviewedTimer);
      entry.unviewedTimer = null;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  handleDonePlay(entry) {
    entry.viewers = Math.max(0, entry.viewers - 1);
    if (entry.viewers > 0) return;
    entry.audio?.markViewerDisconnected();
    // 0 means no grace period: stop immediately after the last viewer leaves.
    if (this.viewerIdleGraceMs <= 0) {
      void this.stopEntry(entry);
      return;
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.viewers === 0) void this.stopEntry(entry);
    }, this.viewerIdleGraceMs);
  }

  findEntry(sessionId) {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return entry;
    }
    return null;
  }

  streamUrl(sessionId) {
    const entry = this.findEntry(sessionId);
    if (entry) return entry.streamUrl;
    return `${this.flvBaseUrl}/live/${this.streamKey(
      sessionId
    )}.flv?v=${this.streamVersion}`;
  }

  async ensureStream(sessionId, options = {}) {
    let entry = this.findEntry(sessionId);

    if (!options.fresh && entry) {
      if (entry.process && !entry.process.killed && entry.ready) {
        return { streamUrl: entry.streamUrl, readyMs: 0 };
      }
      if (entry.readyPromise && !entry.ready) return entry.readyPromise;
      await this.stopEntry(entry);
      entry = null;
    } else if (options.fresh && entry) {
      void this.stopEntry(entry);
      entry = null;
    }

    if (this.entries.size >= this.maxActiveStreams) {
      const error = new Error(
        `同时游玩人数已达上限（${this.maxActiveStreams}），请稍后重试`
      );
      error.statusCode = 429;
      throw error;
    }

    const generation = options.fresh
      ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : "base";
    const key = this.streamKey(sessionId, generation);
    entry = this.createEntry(sessionId, key);
    entry.readyPromise = (async () => {
      const startedAt = Date.now();
      await this.waitForPublish(entry, 5000);
      await this.waitForFirstFrame(entry, 2000);
      await delay(50);
      entry.ready = true;
      return {
        streamUrl: entry.streamUrl,
        readyMs: Date.now() - startedAt,
      };
    })().catch((error) => {
      entry.lastError = error.message;
      entry.ready = false;
      this.stopEntry(entry);
      throw error;
    });

    return entry.readyPromise;
  }

  createEntry(sessionId, key) {
    const streamUrl = `${this.flvBaseUrl}/live/${key}.flv?v=${this.streamVersion}`;
    const renderer = createRenderer({ width: this.width, height: this.height });
    const rtmpUrl = `rtmp://127.0.0.1:${this.rtmpPort}/live/${key}`;

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "2",
      "-thread_queue_size",
      "512",
      "-i",
      "pipe:3",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${this.width}x${this.height}`,
      "-r",
      String(this.fps),
      "-thread_queue_size",
      "512",
      "-i",
      "pipe:0",
      "-map",
      "1:v:0",
      "-map",
      "0:a:0",
      ...videoEncoderArgs(this.encoder, {
        gop: this.gop,
        bitrate: this.bitrate,
        maxrate: this.maxrate,
        bufsize: this.bufsize,
        vaapiDevice: this.vaapiDevice,
      }),
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-flvflags",
      "no_duration_filesize",
      "-f",
      "flv",
      rtmpUrl,
    ];

    const process = spawn("ffmpeg", args, {
      stdio: ["pipe", "ignore", "pipe", "pipe"],
    });
    console.log(
      `[rex2048] ffmpeg started encoder=${this.encoder} key=${key}`
    );

    const entry = {
      sessionId,
      key,
      streamUrl,
      process,
      renderer,
      timer: null,
      published: false,
      ready: false,
      readyPromise: null,
      publishWaiters: [],
      firstFrameWaiters: [],
      lastError: "",
      stopping: false,
      stopPromise: null,
      viewers: 0,
      unviewedTimer: null,
      idleTimer: null,
      audio: new GameAudio({
        sampleRate: SAMPLE_RATE,
        channels: 2,
      }),
      audioCarry: 0,
      frames: 0,
    };

    process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        entry.lastError = text.slice(-1000);
        console.error(`[rex2048] ffmpeg: ${entry.lastError}`);
      }
    });

    process.once("error", (error) => {
      entry.lastError = error.message;
      console.error("[rex2048] ffmpeg spawn failed:", error);
      this.failWaiters(entry, new Error(`ffmpeg 启动失败：${error.message}`));
      entry.process = null;
      void this.stopEntry(entry);
    });

    process.stdin.on("error", (error) => {
      entry.lastError = `ffmpeg stdin 写入失败：${error.message}`;
      if (!entry.stopping) {
        this.failWaiters(entry, new Error(entry.lastError));
        void this.stopEntry(entry);
      }
    });

    process.stdio[3]?.on("error", (error) => {
      entry.lastError = `ffmpeg audio stdin 写入失败：${error.message}`;
      if (!entry.stopping) {
        this.failWaiters(entry, new Error(entry.lastError));
        void this.stopEntry(entry);
      }
    });

    process.once("exit", (code, signal) => {
      entry.ready = false;
      entry.published = false;
      entry.readyPromise = null;
      if (entry.timer) clearInterval(entry.timer);
      if (!entry.stopping) {
        entry.lastError = `ffmpeg 退出：code=${code} signal=${signal || "none"}`;
        console.error(
          `[rex2048] ffmpeg exited code=${code} signal=${signal || "none"} lastError=${entry.lastError}`
        );
      }
      this.failWaiters(
        entry,
        new Error(`视频进程已退出：code=${code} signal=${signal || "none"}`)
      );
      if (!entry.stopping) {
        entry.renderer.close();
        this.entries.delete(entry.key);
      }
      entry.process = null;
    });

    entry.timer = setInterval(() => this.renderEntry(entry), 1000 / this.fps);
    this.entries.set(key, entry);
    return entry;
  }

  renderEntry(entry) {
    const process = entry.process;
    if (!process || process.killed || entry.stopping) return;
    const audioStream = process.stdio[3];
    const videoWritable =
      process.stdin &&
      !process.stdin.destroyed &&
      !process.stdin.writableEnded &&
      !process.stdin.writableNeedDrain;
    const audioWritable =
      audioStream &&
      !audioStream.destroyed &&
      !audioStream.writableEnded &&
      !audioStream.writableNeedDrain;
    const startup = !entry.published;
    if (!audioWritable) return;
    if (!videoWritable && !startup) return;

    try {
      const game = this.getGame(entry.sessionId);
      const state = renderStateForGame(game);
      entry.audioCarry += SAMPLE_RATE / this.fps;
      const audioSamples = Math.floor(entry.audioCarry);
      entry.audioCarry -= audioSamples;
      if (audioSamples > 0) {
        audioStream.write(entry.audio.render(audioSamples, state));
      }
      const frame = entry.renderer.render(state, {
        lastCommand: state.lastCommand,
        commandSeq: state.commandSeq,
      });
      process.stdin.write(frame, (error) => {
        if (!error) return;
        entry.lastError = `ffmpeg stdin 写入失败：${error.message}`;
        if (!entry.stopping) void this.stopEntry(entry);
      });
      entry.frames += 1;
      if (entry.frames === 1) {
        entry.firstFrameWaiters.splice(0).forEach((waiter) => {
          clearTimeout(waiter.timer);
          waiter.resolve();
        });
      }
    } catch (error) {
      entry.lastError = error.message;
      console.error("[rex2048] render failed:", error);
      if (!entry.stopping) void this.stopEntry(entry);
    }
  }

  waitForPublish(entry, timeoutMs) {
    if (entry.published) return Promise.resolve();
    if (!entry.process || entry.process.exitCode !== null) {
      return Promise.reject(new Error("视频进程已退出"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = entry.publishWaiters.findIndex((item) => item.timer === timer);
        if (index >= 0) entry.publishWaiters.splice(index, 1);
        reject(new Error("等待视频首帧超时"));
      }, timeoutMs);
      entry.publishWaiters.push({ resolve, reject, timer });
    });
  }

  waitForFirstFrame(entry, timeoutMs) {
    if (entry.frames > 0) return Promise.resolve();
    if (!entry.process || entry.process.exitCode !== null) {
      return Promise.reject(new Error("视频进程已退出"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = entry.firstFrameWaiters.findIndex(
          (item) => item.timer === timer
        );
        if (index >= 0) entry.firstFrameWaiters.splice(index, 1);
        reject(new Error("等待视频首帧超时"));
      }, timeoutMs);
      entry.firstFrameWaiters.push({ resolve, reject, timer });
    });
  }

  failWaiters(entry, error) {
    entry.publishWaiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    entry.firstFrameWaiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
  }

  stopEntry(entry) {
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopPromise || Promise.resolve();
    entry.stopping = true;
    entry.ready = false;
    entry.readyPromise = null;
    this.clearEntryTimers(entry);
    if (entry.timer) clearInterval(entry.timer);
    this.failWaiters(entry, new Error("视频流已停止"));
    entry.renderer.close();
    const process = entry.process;
    this.entries.delete(entry.key);

    if (!process || process.exitCode !== null) {
      entry.process = null;
      return Promise.resolve();
    }

    entry.stopPromise = new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let giveUpTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        entry.process = null;
        resolve();
      };

      process.once("exit", finish);
      process.once("error", finish);
      try {
        process.kill("SIGTERM");
      } catch (_error) {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        if (settled || process.exitCode !== null) return;
        try {
          process.kill("SIGKILL");
        } catch (_error) {
          finish();
        }
      }, 1200);
      giveUpTimer = setTimeout(finish, 2500);
    });
    this.pendingStops.add(entry.stopPromise);
    entry.stopPromise.finally(() => {
      this.pendingStops.delete(entry.stopPromise);
    });
    return entry.stopPromise;
  }

  stop(sessionId) {
    const entry = this.findEntry(sessionId);
    if (entry) void this.stopEntry(entry);
  }

  async stopAll() {
    await Promise.all(
      Array.from(this.entries.values()).map((entry) => this.stopEntry(entry))
    );
    if (this.pendingStops.size > 0) {
      await Promise.all(Array.from(this.pendingStops));
    }
    if (this.nms && this.running) {
      await this.nms.stop();
      this.running = false;
    }
  }

  health() {
    return {
      ffmpeg: this.ffmpegAvailable,
      nms: this.running,
      encoder: this.encoder,
      encoderRequested: this.requestedEncoder,
      maxActiveStreams: this.maxActiveStreams,
      capacityWarning: this.capacityWarning,
      video: {
        width: this.width,
        height: this.height,
        fps: this.fps,
        bitrate: this.bitrate,
        maxrate: this.maxrate,
        bufsize: this.bufsize,
        gop: this.gop,
      },
      audio: {
        sampleRate: SAMPLE_RATE,
        bitrate: "64k",
      },
      limits: {
        unviewedTimeoutMs: this.unviewedTimeoutMs,
        viewerIdleGraceMs: this.viewerIdleGraceMs,
      },
      activeStreams: this.entries.size,
      streams: Array.from(this.entries.values()).map((entry) => ({
        sessionId: entry.sessionId,
        streamUrl: entry.streamUrl,
        published: entry.published,
        ready: entry.ready,
        frames: entry.frames,
        lastError: entry.lastError,
      })),
    };
  }
}

module.exports = {
  StreamManager,
  streamKeyForSession,
  renderStateForGame,
  chooseEncoder,
  detectEncoders,
  videoEncoderArgs,
};
