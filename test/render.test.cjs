const assert = require("node:assert/strict");
const test = require("node:test");
const { createCanvas } = require("@napi-rs/canvas");
const {
  createRenderer,
  displayStatsForState,
  fitTileFontSize,
  dinoFrameForState,
} = require("../server/render.cjs");

test("displayed score waits for the move animation to finish", () => {
  const state = {
    score: 52,
    best: 100,
    animation: {
      type: "move",
      startedAt: 1000,
      durationMs: 500,
      scoreBefore: 40,
      bestBefore: 90,
    },
  };

  assert.deepEqual(displayStatsForState(state, 1100), {
    score: 40,
    best: 90,
  });
  assert.deepEqual(displayStatsForState(state, 1500), {
    score: 52,
    best: 100,
  });
});

test("large tile numbers shrink to fit inside the tile", () => {
  const ctx = createCanvas(100, 100).getContext("2d");
  const maxWidth = 80;

  for (const value of [128, 1024, 8192, 65536, 131072, 262144]) {
    const text = String(value);
    const baseSize =
      text.length <= 3 ? 38 : text.length === 4 ? 29 : 23;
    const fontSize = fitTileFontSize(
      ctx,
      text,
      baseSize,
      maxWidth,
      10
    );
    const width = ctx.measureText(text).width;

    assert.ok(fontSize >= 10, `${value} should keep a readable size`);
    assert.ok(
      width <= maxWidth + 0.01,
      `${value} width ${width} should fit within ${maxWidth}`
    );
  }
});

test("max-score ending uses the celebrating dino frames", () => {
  const cheatState = {
    over: true,
    won: true,
    cheatEnding: true,
    cheatAt: Date.now(),
    animation: null,
  };
  const frames = new Set([
    dinoFrameForState(cheatState, 1000),
    dinoFrameForState(cheatState, 1300),
  ]);

  assert.deepEqual([...frames].sort(), ["cheer", "happy"]);

  const gameOverState = {
    over: true,
    won: false,
    cheatEnding: false,
    cheatAt: 0,
    animation: null,
  };
  assert.equal(dinoFrameForState(gameOverState, 1000), "over");
});

function dinoOutlineBounds(frame, width) {
  const minX = 1070;
  const maxX = 1210;
  const minY = 450;
  const maxY = 600;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const offset = (y * width + x) * 4;
      const r = frame[offset];
      const g = frame[offset + 1];
      const b = frame[offset + 2];
      const outline =
        (r === 53 && g === 58 && b === 86) ||
        (r === 8 && g === 10 && b === 11);
      if (!outline) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return { left, right, bottom };
}

test("idle dino stays anchored to the same ground position", () => {
  const width = 1280;
  const height = 720;
  const renderer = createRenderer({ width, height });
  const state = {
    board: Array.from({ length: 4 }, () => Array(4).fill(0)),
    score: 0,
    best: 0,
    over: false,
    won: false,
    commandSeq: 0,
    lastCommand: "new",
    language: "zh-Hans",
    animation: null,
  };
  const originalNow = Date.now;

  try {
    Date.now = () => 1_000_000;
    const first = dinoOutlineBounds(
      renderer.render(state, { lastCommand: "new", commandSeq: 0 }),
      width
    );
    Date.now = () => 1_000_800;
    const second = dinoOutlineBounds(
      renderer.render(state, { lastCommand: "new", commandSeq: 0 }),
      width
    );

    assert.ok(first.left < first.right);
    assert.ok(first.bottom > 500);
    assert.equal(second.left, first.left);
    assert.equal(second.right, first.right);
    assert.equal(second.bottom, first.bottom);
  } finally {
    Date.now = originalNow;
    renderer.close();
  }
});
