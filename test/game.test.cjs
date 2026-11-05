const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGame,
  applyEpisode,
  moveBoard,
  moveBoardWithTracks,
  hasMoves,
  serializeState,
  CHEAT_SEQUENCE,
  MAX_SCORE,
  MAX_BOARD,
} = require("../server/game.cjs");

function makeGame(board, score = 0) {
  const game = createGame({ rng: () => 0 });
  game.board = board.map((row) => row.slice());
  game.score = score;
  game.moveCount = 0;
  game.history = [];
  game.over = false;
  game.won = false;
  game.commandSeq = 0;
  game.lastCommand = "new";
  return game;
}

test("new game starts with two tiles", () => {
  const game = createGame({ rng: () => 0 });
  const values = game.board.flat().filter(Boolean);
  assert.equal(values.length, 2);
  assert.ok(values.every((value) => value === 2));
});

test("the same seed reproduces the same initial board", () => {
  const first = createGame({ seed: 123456789 });
  const second = createGame({ seed: 123456789 });

  assert.equal(first.seed, 123456789);
  assert.equal(second.seed, 123456789);
  assert.deepEqual(first.board, second.board);
  assert.equal(first.rngState, second.rngState);
});

test("a new game generates a fresh seed", () => {
  const game = createGame({ seed: 123456789 });
  const previousSeed = game.seed;
  const previousState = game.rngState;

  assert.equal(applyEpisode(game, 1).applied, true);
  assert.notEqual(game.seed, previousSeed);
  assert.notEqual(game.rngState, previousState);
  assert.equal(game.board.flat().filter(Boolean).length, 2);
});

test("left move merges pairs and scores once", () => {
  const result = moveBoard(
    [
      [2, 2, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    "left"
  );
  assert.deepEqual(result.board[0], [4, 4, 0, 0]);
  assert.equal(result.gained, 4);
  assert.equal(result.changed, true);
});

test("move tracks describe slide and merge targets", () => {
  const result = moveBoardWithTracks(
    [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    "left"
  );
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks[0].to, { row: 0, col: 0 });
  assert.deepEqual(result.tracks[1].to, { row: 0, col: 0 });
  assert.equal(result.tracks[0].merge, true);
  assert.deepEqual(result.merges, [
    { row: 0, col: 0, value: 4, gained: 4 },
  ]);
});

test("right, up and down directions preserve merge semantics", () => {
  const source = [
    [2, 0, 0, 2],
    [4, 0, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.deepEqual(moveBoard(source, "right").board[0], [0, 0, 0, 4]);
  assert.deepEqual(moveBoard(source, "up").board[0], [2, 0, 0, 2]);
  assert.deepEqual(moveBoard(source, "down").board[3], [4, 0, 0, 4]);
});

test("no-op move does not spawn or create history", () => {
  const game = makeGame([
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [512, 1024, 2, 4],
    [8, 16, 32, 64],
  ]);
  const before = JSON.stringify(game.board);
  const result = applyEpisode(game, 4);
  assert.equal(result.applied, false);
  assert.equal(JSON.stringify(game.board), before);
  assert.equal(game.history.length, 0);
});

test("undo restores board and score", () => {
  const game = makeGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const before = JSON.stringify(game.board);
  assert.equal(applyEpisode(game, 4).applied, true);
  assert.notEqual(JSON.stringify(game.board), before);
  assert.equal(game.animation.type, "move");
  assert.equal(game.animation.direction, "left");
  assert.equal(game.animation.durationMs, 500);
  assert.ok(game.animation.tracks.length >= 1);
  assert.equal(game.animation.scoreBefore, 0);
  assert.equal(game.animation.bestBefore, 0);
  assert.equal(applyEpisode(game, 7).applied, true);
  assert.equal(JSON.stringify(game.board), before);
  assert.equal(game.score, 0);
});

test("move count only tracks successful moves in the current game", () => {
  const game = makeGame([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);

  assert.equal(applyEpisode(game, 4).applied, true);
  assert.equal(game.moveCount, 1);
  game.board = [
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [512, 1024, 2, 4],
    [8, 16, 32, 64],
  ];
  assert.equal(applyEpisode(game, 4).applied, false);
  assert.equal(game.moveCount, 1);
  assert.equal(applyEpisode(game, 7).applied, true);
  assert.equal(game.moveCount, 0);
  assert.equal(applyEpisode(game, 1).applied, true);
  assert.equal(game.moveCount, 0);
});

test("undo with empty history is a no-op", () => {
  const game = makeGame([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(applyEpisode(game, 7).applied, false);
});

test("repeat executes the previous direction again", () => {
  const game = createGame({ rng: () => 0.999 });
  game.board = [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.equal(applyEpisode(game, 4).applied, true);
  assert.equal(game.lastCommand, "left");
  const seq = game.commandSeq;
  assert.equal(applyEpisode(game, 6).applied, true);
  assert.equal(game.commandSeq, seq + 1);
  assert.equal(game.lastCommand, "left");
});

test("repeat is a no-op before a direction exists", () => {
  const game = createGame({ rng: () => 0 });
  const seq = game.commandSeq;
  assert.equal(applyEpisode(game, 6).applied, false);
  assert.equal(game.commandSeq, seq);
});

test("2048 tile marks the game as won", () => {
  const game = makeGame([
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(applyEpisode(game, 4).applied, true);
  assert.equal(game.won, true);
});

test("full board without equal neighbours has no moves", () => {
  const board = [
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [512, 1024, 2, 4],
    [8, 16, 32, 64],
  ];
  assert.equal(hasMoves(board), false);
});

test("Konami episode sequence grants the max-score ending", () => {
  const game = createGame({ rng: () => 0 });
  for (const episode of CHEAT_SEQUENCE) {
    applyEpisode(game, episode);
  }
  assert.equal(game.cheatEnding, true);
  assert.equal(game.score, MAX_SCORE);
  assert.equal(game.best, MAX_SCORE);
  assert.equal(game.over, true);
  assert.equal(game.won, true);
  assert.deepEqual(game.board, MAX_BOARD);
  assert.ok(game.cheatAt > 0);
});

test("classic Konami sequence with repeats is also accepted", () => {
  const game = createGame({ rng: () => 0 });
  for (const episode of [2, 6, 3, 6, 4, 6, 5, 6, 7, 6]) {
    applyEpisode(game, episode);
  }
  assert.equal(game.cheatEnding, true);
  assert.equal(game.score, MAX_SCORE);
  assert.deepEqual(game.board, MAX_BOARD);
});

test("state serialization contains the public fields", () => {
  const game = createGame({ rng: () => 0, language: "en" });
  game.board = [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const state = serializeState(game);
  assert.deepEqual(state.board, game.board);
  assert.equal(state.score, 0);
  assert.equal(state.over, false);
  assert.equal(state.lastCommand, "new");
  assert.equal(state.language, "en");
  assert.equal(state.seed, game.seed);
});
