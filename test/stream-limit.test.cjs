const assert = require("node:assert/strict");
const test = require("node:test");
const {
  StreamManager,
  renderStateForGame,
} = require("../server/stream.cjs");

test("stream render state includes the current game move count", () => {
  assert.equal(renderStateForGame({ moveCount: 7 }).moveCount, 7);
  assert.equal(renderStateForGame(null).moveCount, 0);
});

test("active stream limit rejects the next session", async () => {
  const manager = new StreamManager({ maxActiveStreams: 2 });
  manager.entries.set("a", { sessionId: "a" });
  manager.entries.set("b", { sessionId: "b" });

  await assert.rejects(
    () => manager.ensureStream("c"),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /上限/);
      return true;
    }
  );
});
