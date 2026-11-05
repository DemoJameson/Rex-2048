const crypto = require("node:crypto");
const episodes = require("../shared/episodes.json");
const { normalizeLanguage } = require("./i18n.cjs");

const SIZE = 4;
const HISTORY_LIMIT = 20;
const CHEAT_SEQUENCE = [2, 3, 4, 5, 2, 3, 4, 5, 6, 7];
const CHEAT_SEQUENCES = [
  CHEAT_SEQUENCE,
  [2, 6, 3, 6, 4, 6, 5, 6, 7, 6],
];
const CHEAT_MAX_LENGTH = Math.max(
  ...CHEAT_SEQUENCES.map((sequence) => sequence.length)
);
const MAX_SCORE = 3932156;
const MAX_BOARD = [
  [131072, 65536, 32768, 16384],
  [8192, 4096, 2048, 1024],
  [512, 256, 128, 64],
  [32, 16, 8, 4],
];
const EPISODES = episodes;
const EPISODE_BY_NUMBER = new Map(
  EPISODES.map((episode) => [episode.episode, episode])
);

function normalizeSeed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : null;
}

function randomSeed() {
  return crypto.randomBytes(4).readUInt32LE(0);
}

function createSeededRng(seed) {
  let state = normalizeSeed(seed);
  if (state === null) state = randomSeed();

  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  rng.getState = () => state;
  rng.setState = (value) => {
    const next = normalizeSeed(value);
    if (next !== null) state = next;
  };
  return rng;
}

function rngStateOf(rng) {
  return typeof rng?.getState === "function" ? rng.getState() : 0;
}

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function randomIndex(rng, length) {
  return Math.min(length - 1, Math.max(0, Math.floor(rng() * length)));
}

function addRandomTile(board, rng = Math.random) {
  const empty = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (board[row][col] === 0) empty.push([row, col]);
    }
  }
  if (empty.length === 0) return null;

  const [row, col] = empty[randomIndex(rng, empty.length)];
  board[row][col] = rng() < 0.9 ? 2 : 4;
  return { row, col, value: board[row][col] };
}

function mergeLine(values) {
  const compact = values.filter((value) => value !== 0);
  const merged = [];
  let gained = 0;

  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === compact[index + 1]) {
      const value = compact[index] * 2;
      merged.push(value);
      gained += value;
      index += 1;
    } else {
      merged.push(compact[index]);
    }
  }

  while (merged.length < SIZE) merged.push(0);
  return { line: merged.slice(0, SIZE), gained };
}

function readLine(board, direction, index) {
  if (direction === "left") return board[index].slice();
  if (direction === "right") return board[index].slice().reverse();
  if (direction === "up") return board.map((row) => row[index]);
  if (direction === "down") return board.map((row) => row[index]).reverse();
  throw new Error(`未知方向：${direction}`);
}

function readLineEntries(board, direction, index) {
  if (direction === "left") {
    return board[index].map((value, col) => ({ value, row: index, col }));
  }
  if (direction === "right") {
    return board[index]
      .map((value, col) => ({ value, row: index, col }))
      .reverse();
  }
  if (direction === "up") {
    return board.map((row, rowIndex) => ({
      value: row[index],
      row: rowIndex,
      col: index,
    }));
  }
  if (direction === "down") {
    return board
      .map((row, rowIndex) => ({
        value: row[index],
        row: rowIndex,
        col: index,
      }))
      .reverse();
  }
  throw new Error(`未知方向：${direction}`);
}

function slotPosition(direction, lineIndex, slot) {
  if (direction === "left") return { row: lineIndex, col: slot };
  if (direction === "right") return { row: lineIndex, col: SIZE - 1 - slot };
  if (direction === "up") return { row: slot, col: lineIndex };
  if (direction === "down") return { row: SIZE - 1 - slot, col: lineIndex };
  throw new Error(`未知方向：${direction}`);
}

function writeLine(board, direction, index, line) {
  if (direction === "left") {
    board[index] = line.slice();
    return;
  }
  if (direction === "right") {
    board[index] = line.slice().reverse();
    return;
  }
  if (direction === "up") {
    for (let row = 0; row < SIZE; row += 1) board[row][index] = line[row];
    return;
  }
  if (direction === "down") {
    for (let row = 0; row < SIZE; row += 1) {
      board[SIZE - 1 - row][index] = line[row];
    }
    return;
  }
  throw new Error(`未知方向：${direction}`);
}

function moveBoard(board, direction) {
  return moveBoardWithTracks(board, direction);
}

function moveBoardWithTracks(board, direction) {
  const next = emptyBoard();
  let gained = 0;
  const tracks = [];
  const merges = [];

  for (let index = 0; index < SIZE; index += 1) {
    const entries = readLineEntries(board, direction, index).filter(
      (entry) => entry.value !== 0
    );
    let targetSlot = 0;

    for (let cursor = 0; cursor < entries.length; cursor += 1) {
      const current = entries[cursor];
      const following = entries[cursor + 1];
      const target = slotPosition(direction, index, targetSlot);

      if (following && following.value === current.value) {
        next[target.row][target.col] = current.value * 2;
        gained += current.value * 2;
        tracks.push({
          value: current.value,
          from: { row: current.row, col: current.col },
          to: target,
          merge: true,
        });
        tracks.push({
          value: following.value,
          from: { row: following.row, col: following.col },
          to: target,
          merge: true,
        });
        merges.push({
          row: target.row,
          col: target.col,
          value: current.value * 2,
          gained: current.value * 2,
        });
        cursor += 1;
      } else {
        next[target.row][target.col] = current.value;
        tracks.push({
          value: current.value,
          from: { row: current.row, col: current.col },
          to: target,
          merge: false,
        });
      }
      targetSlot += 1;
    }
  }

  return {
    board: next,
    gained,
    changed: JSON.stringify(next) !== JSON.stringify(board),
    tracks,
    merges,
  };
}

function hasMoves(board) {
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (board[row][col] === 0) return true;
      if (col + 1 < SIZE && board[row][col] === board[row][col + 1]) {
        return true;
      }
      if (row + 1 < SIZE && board[row][col] === board[row + 1][col]) {
        return true;
      }
    }
  }
  return false;
}

function hasWinningTile(board) {
  return board.some((row) => row.some((value) => value >= 2048));
}

function resetBoard(game, options = {}) {
  if (options.reseed) {
    game.seed = randomSeed();
    game.rng = createSeededRng(game.seed);
  }
  game.board = emptyBoard();
  game.score = 0;
  game.moveCount = 0;
  game.animation = null;
  game.history = [];
  game.over = false;
  game.won = false;
  game.cheatAt = 0;
  game.cheatEnding = false;
  game.recentEpisodes = [];
  game.cheatSeq = 0;
  addRandomTile(game.board, game.rng);
  addRandomTile(game.board, game.rng);
  game.rngState = rngStateOf(game.rng);
  game.updatedAt = Date.now();
}

function createGame(options = {}) {
  const normalizedSeed = normalizeSeed(options.seed);
  const seed = normalizedSeed === null ? randomSeed() : normalizedSeed;
  const rng = options.rng || createSeededRng(seed);
  const game = {
    board: emptyBoard(),
    score: 0,
    moveCount: 0,
    best: 0,
    over: false,
    won: false,
    history: [],
    commandSeq: 0,
    lastCommand: "new",
    cheatAt: 0,
    cheatEnding: false,
    recentEpisodes: [],
    cheatSeq: 0,
    language: normalizeLanguage(options.language),
    updatedAt: Date.now(),
    seed,
    rngState: 0,
    rng,
  };
  resetBoard(game);
  if (options.rngState != null && typeof rng.setState === "function") {
    rng.setState(options.rngState);
    game.rngState = rngStateOf(rng);
  }
  return game;
}

function restoreSnapshot(game, snapshot) {
  game.board = cloneBoard(snapshot.board);
  game.score = snapshot.score;
  game.won = snapshot.won;
  game.over = snapshot.over;
  game.animation = null;
  game.updatedAt = Date.now();
}

function activateCheat(game) {
  if (game.cheatSeq === game.commandSeq) return false;
  const matched = CHEAT_SEQUENCES.some((sequence) => {
    if (game.recentEpisodes.length < sequence.length) return false;
    const tail = game.recentEpisodes.slice(-sequence.length);
    return tail.every((value, index) => value === sequence[index]);
  });
  if (!matched) return false;

  game.cheatSeq = game.commandSeq;
  game.cheatAt = Date.now();
  game.cheatEnding = true;
  game.board = cloneBoard(MAX_BOARD);
  game.score = MAX_SCORE;
  game.best = MAX_SCORE;
  game.over = true;
  game.won = true;
  game.history = [];
  game.animation = null;
  game.updatedAt = Date.now();
  return true;
}

function finishEpisode(game, result) {
  if (activateCheat(game)) {
    result.cheat = true;
    result.ending = true;
  }
  return result;
}

function applyEpisode(game, episodeNumber) {
  const episode = EPISODE_BY_NUMBER.get(Number(episodeNumber));
  if (!episode) throw new Error(`非法选集：${episodeNumber}`);

  game.recentEpisodes.push(episode.episode);
  if (game.recentEpisodes.length > CHEAT_MAX_LENGTH) {
    game.recentEpisodes.shift();
  }

  let command = episode.command;
  if (command === "repeat") {
    command = game.lastCommand;
    if (!["up", "down", "left", "right"].includes(command)) {
      return finishEpisode(game, { applied: false, command: "repeat" });
    }
  }

  game.commandSeq += 1;
  game.lastCommand = command;
  game.updatedAt = Date.now();

  if (command === "new") {
    resetBoard(game, { reseed: true });
    return finishEpisode(game, { applied: true, command });
  }

  if (command === "undo") {
    const snapshot = game.history.pop();
    if (!snapshot) return finishEpisode(game, { applied: false, command });
    restoreSnapshot(game, snapshot);
    game.moveCount = Math.max(0, game.moveCount - 1);
    return finishEpisode(game, { applied: true, command });
  }

  const boardBeforeMove = cloneBoard(game.board);
  const result = moveBoard(game.board, command);
  if (!result.changed) {
    game.animation = null;
    return finishEpisode(game, { applied: false, command });
  }

  game.history.push({
    board: cloneBoard(game.board),
    score: game.score,
    won: game.won,
    over: game.over,
  });
  if (game.history.length > HISTORY_LIMIT) game.history.shift();

  const scoreBefore = game.score;
  const bestBefore = game.best;
  game.board = result.board;
  game.score += result.gained;
  game.best = Math.max(game.best, game.score);
  game.moveCount += 1;
  game.won = game.won || hasWinningTile(game.board);
  const spawned = addRandomTile(game.board, game.rng);
  game.rngState = rngStateOf(game.rng);
  game.over = !hasMoves(game.board);
  game.updatedAt = Date.now();
  game.animation = {
    type: "move",
    direction: command,
    fromBoard: cloneBoard(boardBeforeMove),
    toBoard: cloneBoard(game.board),
    scoreBefore,
    bestBefore,
    tracks: result.tracks,
    merges: result.merges,
    spawn: spawned
      ? {
          value: game.board[spawned.row][spawned.col],
          to: { row: spawned.row, col: spawned.col },
        }
      : null,
    startedAt: Date.now(),
    durationMs: 500,
  };

  return finishEpisode(game, { applied: true, command });
}

function serializeState(game) {
  return {
    board: cloneBoard(game.board),
    score: game.score,
    moveCount: game.moveCount,
    best: game.best,
    over: game.over,
    won: game.won,
    commandSeq: game.commandSeq,
    lastCommand: game.lastCommand,
    cheatAt: game.cheatAt,
    cheatEnding: game.cheatEnding,
    seed: game.seed,
    language: game.language,
    updatedAt: game.updatedAt,
  };
}

function randomSessionId() {
  return `local-${crypto.randomBytes(8).toString("hex")}`;
}

module.exports = {
  SIZE,
  HISTORY_LIMIT,
  CHEAT_SEQUENCE,
  CHEAT_SEQUENCES,
  MAX_SCORE,
  MAX_BOARD,
  EPISODES,
  EPISODE_BY_NUMBER,
  emptyBoard,
  cloneBoard,
  createSeededRng,
  randomSeed,
  rngStateOf,
  addRandomTile,
  mergeLine,
  moveBoard,
  moveBoardWithTracks,
  hasMoves,
  hasWinningTile,
  createGame,
  applyEpisode,
  serializeState,
  randomSessionId,
};
