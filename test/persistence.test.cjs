const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SessionStore } = require("../server/sessions.cjs");

test("sessions survive a store restart with board, score and history", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rex2048-persistence-")
  );
  const persistPath = path.join(directory, "sessions.json");

  try {
    const store = new SessionStore({
      maxSessions: 3,
      persistPath,
    });
    const session = store.getOrCreate("persist-session-01");
    session.game.board = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    session.game.rng = () => 0;

    const result = store.applyCommand(
      "persist-session-01",
      4,
      "persist-session-01:4:1"
    );
    assert.equal(result.applied, true);
    const board = JSON.stringify(session.game.board);
    const score = session.game.score;
    const moveCount = session.game.moveCount;
    const historyLength = session.game.history.length;
    const seed = session.game.seed;

    const restored = new SessionStore({
      maxSessions: 3,
      persistPath,
    });
    assert.equal(restored.load(), 1);
    const saved = restored.get("persist-session-01");
    assert.ok(saved);
    assert.equal(JSON.stringify(saved.game.board), board);
    assert.equal(saved.game.score, score);
    assert.equal(saved.game.moveCount, moveCount);
    assert.equal(saved.game.history.length, historyLength);
    assert.equal(saved.game.seed, seed);

    const undo = restored.applyCommand(
      "persist-session-01",
      7,
      "persist-session-01:7:1"
    );
    assert.equal(undo.applied, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a corrupt persistence file falls back to an empty store", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rex2048-persistence-corrupt-")
  );
  const persistPath = path.join(directory, "sessions.json");

  try {
    fs.writeFileSync(persistPath, "{not-json", "utf8");
    const store = new SessionStore({ persistPath });
    assert.equal(store.load(), 0);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
