const assert = require("node:assert/strict");
const test = require("node:test");
const { GameAudio } = require("../server/audio.cjs");

function peak(buffer) {
  let maximum = 0;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    maximum = Math.max(maximum, Math.abs(buffer.readInt16LE(offset)));
  }
  return maximum;
}

test("audio engine renders move and merge effects", () => {
  const audio = new GameAudio({
    sampleRate: 48000,
    channels: 2,
  });
  audio.markViewerConnected();
  const state = {
    commandSeq: 1,
    lastCommand: "left",
    over: false,
    cheatEnding: false,
    animation: {
      startedAt: Date.now() + 200,
      durationMs: 500,
      merges: [{ row: 0, col: 0, value: 4 }],
    },
  };

  let maximum = 0;
  for (let frame = 0; frame < 50; frame += 1) {
    const buffer = audio.render(800, state);
    assert.equal(buffer.length, 800 * 2 * 2);
    maximum = Math.max(maximum, peak(buffer));
  }

  assert.ok(maximum > 500);
  assert.ok(maximum <= 32767);
});

test("audio engine renders a new-game cue without animation", () => {
  const audio = new GameAudio({
    sampleRate: 48000,
    channels: 2,
  });
  audio.markViewerConnected();
  const state = {
    commandSeq: 1,
    lastCommand: "new",
    over: false,
    cheatEnding: false,
    animation: null,
  };

  let maximum = 0;
  for (let frame = 0; frame < 20; frame += 1) {
    maximum = Math.max(maximum, peak(audio.render(800, state)));
  }

  assert.ok(maximum > 500);
  assert.ok(maximum <= 32767);
});

test("move cues wait for a viewer instead of playing into a prewarmed stream", () => {
  const audio = new GameAudio({
    sampleRate: 48000,
    channels: 2,
  });
  const state = {
    commandSeq: 1,
    lastCommand: "left",
    over: false,
    cheatEnding: false,
    animation: {
      direction: "left",
      startedAt: Date.now(),
      durationMs: 500,
      merges: [],
    },
  };

  const prewarmBuffer = audio.render(800, state);
  assert.equal(peak(prewarmBuffer), 0);
  assert.ok(audio.pendingMove);
  assert.equal(audio.voices.length, 0);

  audio.markViewerConnected();
  assert.equal(audio.pendingMove, null);
  assert.ok(audio.voices.length > 0);

  let maximum = 0;
  for (let frame = 0; frame < 20; frame += 1) {
    maximum = Math.max(maximum, peak(audio.render(800, state)));
  }
  assert.ok(maximum > 500);
});

test("move cues wait again after the last viewer leaves", () => {
  const audio = new GameAudio({
    sampleRate: 48000,
    channels: 2,
  });
  audio.markViewerConnected();
  audio.markViewerDisconnected();
  const state = {
    commandSeq: 1,
    lastCommand: "right",
    over: false,
    cheatEnding: false,
    animation: {
      direction: "right",
      startedAt: Date.now(),
      durationMs: 500,
      merges: [],
    },
  };

  const buffer = audio.render(800, state);
  assert.equal(peak(buffer), 0);
  assert.ok(audio.pendingMove);
});

test("non-move cues wait for a viewer and prewarm stays silent", () => {
  const audio = new GameAudio({
    sampleRate: 48000,
    channels: 2,
  });
  const prewarm = {
    commandSeq: 0,
    lastCommand: "new",
    over: false,
    cheatEnding: false,
    animation: null,
  };
  const prewarmBuffer = audio.render(800, prewarm);
  assert.equal(peak(prewarmBuffer), 0);
  assert.equal(audio.pendingNonMove, null);
  assert.equal(audio.voices.length, 0);

  const newGame = {
    ...prewarm,
    commandSeq: 1,
  };
  audio.render(800, newGame);
  assert.ok(audio.pendingNonMove);
  assert.equal(audio.voices.length, 0);

  audio.markViewerConnected();
  assert.equal(audio.pendingNonMove, null);
  assert.ok(audio.voices.length > 0);
});

test("each direction has its own cue with a phone-friendly presence layer", () => {
  const signatures = new Map();

  for (const direction of ["up", "down", "left", "right"]) {
    const audio = new GameAudio({ sampleRate: 48000, channels: 2 });
    audio.markViewerConnected();
    const state = {
      commandSeq: 1,
      lastCommand: direction,
      over: false,
      cheatEnding: false,
      animation: {
        direction,
        startedAt: Date.now(),
        durationMs: 500,
        merges: [],
      },
    };

    let maximum = 0;
    for (let frame = 0; frame < 10; frame += 1) {
      maximum = Math.max(maximum, peak(audio.render(800, state)));
    }

    assert.ok(maximum > 400, `${direction} cue should be audible`);
    assert.ok(maximum < 26000, `${direction} cue should not clip`);
    const bodyVoices = audio.voices.filter((voice) => voice.freq < 600);
    assert.ok(bodyVoices.length >= 2);
    assert.ok(
      audio.voices.some(
        (voice) => voice.freq >= 700 && voice.freq <= 1100
      ),
      `${direction} cue should include a presence layer`
    );
    signatures.set(
      direction,
      bodyVoices
        .slice(0, 2)
        .map((voice) => Math.round(voice.freq))
        .join(":")
    );
  }

  assert.equal(new Set(signatures.values()).size, 4);
});

test("merge cue sits slightly below the slide cue", () => {
  function render(merges) {
    const audio = new GameAudio({ sampleRate: 48000, channels: 2 });
    audio.markViewerConnected();
    const state = {
      commandSeq: 1,
      lastCommand: "left",
      over: false,
      cheatEnding: false,
      animation: {
        direction: "left",
        startedAt: Date.now(),
        durationMs: 500,
        merges,
      },
    };
    const chunks = [];
    for (let frame = 0; frame < 60; frame += 1) {
      chunks.push(audio.render(800, state));
    }
    return Buffer.concat(chunks);
  }

  function stats(buffer, start, end) {
    const from = Math.round(start * 48000) * 2 * 2;
    const to = Math.round(end * 48000) * 2 * 2;
    let maximum = 0;
    let sum = 0;
    let count = 0;
    for (let offset = from; offset < to; offset += 2) {
      const value = buffer.readInt16LE(offset);
      maximum = Math.max(maximum, Math.abs(value));
      sum += value * value;
      count += 1;
    }
    return { peak: maximum, rms: Math.sqrt(sum / count) };
  }

  const slide = stats(render([]), 0, 0.2);
  const merge = stats(render([{ row: 0, col: 0, value: 4 }]), 0.33, 0.57);
  const peakRatio = merge.peak / slide.peak;
  const rmsRatio = merge.rms / slide.rms;

  assert.ok(slide.peak > 2000);
  assert.ok(merge.peak > 2000);
  assert.ok(
    peakRatio > 0.65 && peakRatio < 0.98,
    `merge peak should sit slightly below slide, got ${peakRatio.toFixed(2)}`
  );
  assert.ok(
    rmsRatio > 0.7 && rmsRatio < 0.98,
    `merge RMS should sit slightly below slide, got ${rmsRatio.toFixed(2)}`
  );
});
