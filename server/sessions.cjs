const fs = require("node:fs");
const path = require("node:path");
const {
  EPISODE_BY_NUMBER,
  HISTORY_LIMIT,
  createGame,
  createSeededRng,
  rngStateOf,
  applyEpisode,
  cloneBoard,
  serializeState,
} = require("./game.cjs");
const { DEFAULT_LANGUAGE, normalizeLanguage } = require("./i18n.cjs");

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9:._-]{8,160}$/;

class SessionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionLimitError";
    this.statusCode = 429;
  }
}

class SessionNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionNotFoundError";
    this.statusCode = 404;
  }
}

function isValidSessionId(value) {
  return SESSION_ID_PATTERN.test(String(value || ""));
}

function isValidCommandId(value) {
  return COMMAND_ID_PATTERN.test(String(value || ""));
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBoard(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const board = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    board.push(
      row.map((cell) => {
        const number = Number(cell);
        return Number.isFinite(number) && number >= 0 ? number : 0;
      })
    );
  }
  return board;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  for (const entry of value.slice(-HISTORY_LIMIT)) {
    const board = normalizeBoard(entry?.board);
    if (!board) continue;
    history.push({
      board,
      score: asNumber(entry.score),
      won: Boolean(entry.won),
      over: Boolean(entry.over),
    });
  }
  return history;
}

function normalizeCommandIds(value) {
  const commandIds = new Map();
  if (!Array.isArray(value)) return commandIds;
  for (const entry of value.slice(-80)) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, meta] = entry;
    if (typeof key !== "string" || !key) continue;
    commandIds.set(key, { at: asNumber(meta?.at) });
  }
  return commandIds;
}

class SessionStore {
  constructor(options = {}) {
    this.maxSessions = Number(options.maxSessions || 128);
    this.dedupeWindowMs = Number(options.dedupeWindowMs || 2000);
    this.now = options.now || Date.now;
    this.persistPath = options.persistPath
      ? String(options.persistPath)
      : null;
    this.sessions = new Map();
  }

  load() {
    if (!this.persistPath) return 0;

    let raw;
    try {
      raw = fs.readFileSync(this.persistPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("[rex2048] read sessions failed:", error);
      }
      return 0;
    }

    try {
      const data = JSON.parse(raw);
      const records = Array.isArray(data?.sessions) ? data.sessions : [];
      const now = this.now();
      for (const record of records.slice(0, this.maxSessions)) {
        const session = this.restoreRecord(record, now);
        if (session) this.sessions.set(session.id, session);
      }
      return this.sessions.size;
    } catch (error) {
      console.warn("[rex2048] parse sessions failed:", error);
      return 0;
    }
  }

  save() {
    if (!this.persistPath) return false;

    try {
      const directory = path.dirname(this.persistPath);
      fs.mkdirSync(directory, { recursive: true });
      const payload = {
        version: 1,
        savedAt: this.now(),
        sessions: Array.from(this.sessions.values()).map((session) => ({
          sessionId: session.id,
          language: session.language,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          game: {
            board: cloneBoard(session.game.board),
            score: session.game.score,
            moveCount: session.game.moveCount,
            best: session.game.best,
            over: session.game.over,
            won: session.game.won,
            history: session.game.history.map((entry) => ({
              board: cloneBoard(entry.board),
              score: entry.score,
              won: entry.won,
              over: entry.over,
            })),
            commandSeq: session.game.commandSeq,
            lastCommand: session.game.lastCommand,
            seed: session.game.seed,
            rngState: session.game.rngState,
            cheatEnding: Boolean(session.game.cheatEnding),
            language: session.game.language,
            updatedAt: session.game.updatedAt,
          },
          recentCommands: session.recentCommands.slice(-20),
          commandIds: Array.from(session.commandIds.entries()).slice(-80),
        })),
      };
      const temporary = `${this.persistPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
      fs.renameSync(temporary, this.persistPath);
      return true;
    } catch (error) {
      console.warn("[rex2048] save sessions failed:", error);
      return false;
    }
  }

  restoreRecord(record, now) {
    if (!record || !isValidSessionId(record.sessionId)) return null;
    const data = record.game || {};
    const board = normalizeBoard(data.board);
    if (!board) return null;

    const language = normalizeLanguage(data.language || record.language);
    const game = createGame({ language, seed: data.seed });
    if (
      typeof game.rng.setState === "function" &&
      data.rngState != null &&
      Number.isFinite(Number(data.rngState))
    ) {
      game.rng.setState(Number(data.rngState));
      game.rngState = rngStateOf(game.rng);
    }
    game.board = board;
    game.score = asNumber(data.score);
    game.best = asNumber(data.best);
    game.over = Boolean(data.over);
    game.won = Boolean(data.won);
    game.history = normalizeHistory(data.history);
    game.moveCount = asNumber(data.moveCount, game.history.length);
    game.commandSeq = asNumber(data.commandSeq);
    game.lastCommand = String(data.lastCommand || "new");
    game.cheatAt = 0;
    game.cheatEnding = Boolean(data.cheatEnding);
    game.recentEpisodes = [];
    game.cheatSeq = 0;
    game.language = language;
    game.updatedAt = asNumber(data.updatedAt) || now;
    game.animation = null;

    return {
      id: record.sessionId,
      language,
      game,
      createdAt: asNumber(record.createdAt) || now,
      lastSeenAt: now,
      commandIds: normalizeCommandIds(record.commandIds),
      recentCommands: Array.isArray(record.recentCommands)
        ? record.recentCommands.slice(-20).map((entry) => ({ ...entry }))
        : [],
    };
  }

  validateSessionId(sessionId) {
    return isValidSessionId(sessionId);
  }

  get(sessionId) {
    return this.sessions.get(String(sessionId)) || null;
  }

  getOrCreate(sessionId, language = null) {
    const id = String(sessionId || "");
    if (!isValidSessionId(id)) {
      throw new Error("sessionId 格式无效");
    }

    const existing = this.sessions.get(id);
    if (existing) {
      if (language) this.setLanguage(id, language);
      existing.lastSeenAt = this.now();
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new SessionLimitError(`最多同时保留 ${this.maxSessions} 个会话`);
    }

    const now = this.now();
    const session = {
      id,
      language: normalizeLanguage(language || DEFAULT_LANGUAGE),
      game: createGame({ language: language || DEFAULT_LANGUAGE }),
      createdAt: now,
      lastSeenAt: now,
      commandIds: new Map(),
      recentCommands: [],
    };
    this.sessions.set(id, session);
    this.save();
    return session;
  }

  setLanguage(sessionId, language) {
    const session = this.sessions.get(String(sessionId));
    if (!session) return false;
    const normalized = normalizeLanguage(language);
    if (
      session.language === normalized &&
      session.game.language === normalized
    ) {
      return true;
    }
    session.language = normalized;
    session.game.language = normalized;
    this.save();
    return true;
  }

  applyCommand(sessionId, episodeNumber, commandId) {
    const episode = EPISODE_BY_NUMBER.get(Number(episodeNumber));
    if (!episode) throw new Error(`非法选集：${episodeNumber}`);
    if (!isValidCommandId(commandId)) throw new Error("commandId 格式无效");

    const session = this.getOrCreate(sessionId);
    const now = this.now();
    const previous = session.commandIds.get(commandId);

    if (previous && now - previous.at < this.dedupeWindowMs) {
      session.lastSeenAt = now;
      return {
        session,
        applied: false,
        duplicate: true,
        command: episode.command,
      };
    }

    session.commandIds.set(commandId, { at: now });
    if (session.commandIds.size > 80) {
      for (const [key, value] of session.commandIds) {
        if (now - value.at > 60_000) session.commandIds.delete(key);
      }
    }

    const result = applyEpisode(session.game, episode.episode);
    session.lastSeenAt = now;
    session.recentCommands.push({
      episode: episode.episode,
      command: episode.command,
      applied: result.applied,
      commandId,
      at: now,
    });
    if (session.recentCommands.length > 20) session.recentCommands.shift();
    this.save();

    return {
      session,
      applied: result.applied,
      duplicate: false,
      command: episode.command,
    };
  }

  deferAnimation(sessionId, delayMs) {
    const session = this.sessions.get(String(sessionId));
    if (!session || !session.game.animation) return false;

    const delay = Math.max(0, Number(delayMs) || 0);
    session.game.animation.startedAt = this.now() + delay;
    return true;
  }

  holdAnimation(sessionId) {
    const session = this.sessions.get(String(sessionId));
    if (!session || !session.game.animation) return false;

    session.game.animation.startedAt = Number.MAX_SAFE_INTEGER;
    return true;
  }

  serialize(session) {
    return {
      sessionId: session.id,
      state: serializeState(session.game),
      recentCommands: session.recentCommands.slice(-20),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
    };
  }

  snapshot(sessionId) {
    const session = this.get(sessionId);
    if (!session) return null;
    return {
      game: {
        board: cloneBoard(session.game.board),
        score: session.game.score,
        moveCount: session.game.moveCount,
        best: session.game.best,
        over: session.game.over,
        won: session.game.won,
        history: session.game.history.map((entry) => ({
          board: cloneBoard(entry.board),
          score: entry.score,
          won: entry.won,
          over: entry.over,
        })),
        commandSeq: session.game.commandSeq,
        lastCommand: session.game.lastCommand,
        cheatAt: session.game.cheatAt,
        cheatEnding: session.game.cheatEnding,
        seed: session.game.seed,
        rngState: session.game.rngState,
        recentEpisodes: session.game.recentEpisodes.slice(),
        cheatSeq: session.game.cheatSeq,
        language: session.game.language,
        updatedAt: session.game.updatedAt,
        animation: session.game.animation
          ? JSON.parse(JSON.stringify(session.game.animation))
          : null,
      },
      recentCommands: session.recentCommands.map((entry) => ({ ...entry })),
      commandIds: new Map(session.commandIds),
      lastSeenAt: session.lastSeenAt,
    };
  }

  restore(sessionId, snapshot) {
    const session = this.get(sessionId);
    if (!session || !snapshot) return false;
    Object.assign(session.game, snapshot.game);
    if (snapshot.game.seed != null) {
      session.game.seed = snapshot.game.seed;
      session.game.rng = createSeededRng(snapshot.game.seed);
      if (snapshot.game.rngState != null) {
        session.game.rng.setState(snapshot.game.rngState);
      }
      session.game.rngState = rngStateOf(session.game.rng);
    }
    session.recentCommands = snapshot.recentCommands.map((entry) => ({
      ...entry,
    }));
    session.commandIds = new Map(snapshot.commandIds);
    session.lastSeenAt = snapshot.lastSeenAt;
    this.save();
    return true;
  }

  list() {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        sessionId: session.id,
        score: session.game.score,
        moveCount: session.game.moveCount,
        best: session.game.best,
        over: session.game.over,
        won: session.game.won,
        commandSeq: session.game.commandSeq,
        lastCommand: session.game.lastCommand,
        language: session.game.language,
        lastSeenAt: session.lastSeenAt,
      }));
  }

  idleSessionIds(maxIdleMs) {
    const now = this.now();
    return Array.from(this.sessions.values())
      .filter((session) => now - session.lastSeenAt > maxIdleMs)
      .map((session) => session.id);
  }

  cleanup(maxIdleMs) {
    const now = this.now();
    const removed = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > maxIdleMs) {
        this.sessions.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.save();
    return removed;
  }
}

module.exports = {
  SessionStore,
  SessionLimitError,
  SessionNotFoundError,
  isValidSessionId,
  isValidCommandId,
  SESSION_ID_PATTERN,
  COMMAND_ID_PATTERN,
};
