const TWO_PI = Math.PI * 2;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MOVE_CUE_GAIN = 0.08;
const MOVE_CUE_SECOND_GAIN = 0.03;
const MERGE_CUE_GAIN = 0.06;
const MERGE_CUE_SECOND_GAIN = 0.03;
const PRESENCE_CUE_GAIN = 0.02;
const MERGE_PRESENCE_CUE_GAIN = 0.006;
const MOVE_TONES = {
  up: {
    freq: 196,
    sweep: 0.26,
    duration: 0.17,
    gain: MOVE_CUE_GAIN,
    second: 246.94,
    secondGain: MOVE_CUE_SECOND_GAIN,
  },
  down: {
    freq: 246.94,
    sweep: -0.3,
    duration: 0.18,
    gain: MOVE_CUE_GAIN,
    second: 164.81,
    secondGain: MOVE_CUE_SECOND_GAIN,
  },
  left: {
    freq: 174.61,
    sweep: -0.04,
    duration: 0.17,
    gain: MOVE_CUE_GAIN,
    second: 130.81,
    secondGain: MOVE_CUE_SECOND_GAIN,
  },
  right: {
    freq: 220,
    sweep: 0.1,
    duration: 0.17,
    gain: MOVE_CUE_GAIN,
    second: 261.63,
    secondGain: MOVE_CUE_SECOND_GAIN,
  },
};

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

class GameAudio {
  constructor(options = {}) {
    this.sampleRate = Number(options.sampleRate || SAMPLE_RATE);
    this.channels = Number(options.channels || CHANNELS);
    this.masterGain = Number(options.masterGain || 10);
    this.time = 0;
    this.voices = [];
    this.lastCommandSeq = -1;
    this.lastAnimationStartedAt = 0;
    this.lastEndingScheduled = false;
    this.lastOverScheduled = false;
    this.viewerConnected = false;
    this.pendingMove = null;
    this.pendingNonMove = null;
  }

  startTimeFor(absoluteMs, nowMs = Date.now()) {
    return this.time + Math.max(0, (absoluteMs - nowMs) / 1000);
  }

  addTone(freq, start, duration, gain, options = {}) {
    this.voices.push({
      freq,
      start: Math.max(this.time, start),
      duration,
      gain,
      sweep: Number(options.sweep || 0),
      attack: Number(options.attack || 0.018),
      decay: Number(options.decay || 3.2),
    });
  }

  addArpeggio(start, freqs, duration, gain, options = {}) {
    const step = Number(options.step || 0.085);
    freqs.forEach((freq, index) => {
      this.addTone(freq, start + index * step, duration, gain, options);
    });
  }

  markViewerConnected() {
    this.viewerConnected = true;
    if (this.pendingMove) {
      const pending = this.pendingMove;
      this.pendingMove = null;
      this.scheduleMove(pending.state, pending.startedAtMs, Date.now());
    }
    if (!this.pendingNonMove) return;
    const pending = this.pendingNonMove;
    this.pendingNonMove = null;
    this.scheduleNonMove(pending, Date.now());
  }

  markViewerDisconnected() {
    this.viewerConnected = false;
  }

  scheduleMove(state, startedAtMs, nowMs) {
    if (!this.viewerConnected) {
      this.pendingMove = { state, startedAtMs, nowMs };
      return;
    }
    const start = this.startTimeFor(startedAtMs, nowMs);
    const animation = state.animation;
    const direction = String(
      animation.direction || state.lastCommand || "left"
    );
    const tone = MOVE_TONES[direction] || MOVE_TONES.left;
    this.addTone(tone.freq, start, tone.duration, tone.gain, {
      sweep: tone.sweep,
      attack: 0.02,
      decay: 3.1,
    });
    this.addTone(
      tone.second,
      start + 0.014,
      tone.duration * 0.9,
      tone.secondGain,
      { attack: 0.024, decay: 3 }
    );
    this.addTone(880, start + 0.005, 0.07, PRESENCE_CUE_GAIN, {
      attack: 0.004,
      decay: 5.5,
    });

    const mergeOffset =
      0.62 * (Number(animation.durationMs) || 500) / 1000 + 0.02;
    if ((animation.merges || []).length > 0) {
      this.addTone(440, start + mergeOffset, 0.22, MERGE_CUE_GAIN, {
        attack: 0.02,
        decay: 3.4,
      });
      this.addTone(
        554.37,
        start + mergeOffset + 0.03,
        0.24,
        MERGE_CUE_SECOND_GAIN,
        {
          attack: 0.02,
          decay: 3.2,
        }
      );
      this.addTone(
        1046.5,
        start + mergeOffset + 0.01,
        0.08,
        MERGE_PRESENCE_CUE_GAIN,
        {
          attack: 0.004,
          decay: 5.5,
        }
      );
    }

    if (state.over && !state.cheatEnding) {
      this.addTone(98, start + 0.5, 0.6, 0.035, { attack: 0.025 });
      this.addTone(130.81, start + 0.64, 0.5, 0.022, { attack: 0.025 });
    }
  }

  scheduleNonMove(state, nowMs) {
    const start = this.startTimeFor(nowMs, nowMs);
    if (state.cheatEnding) {
      this.lastEndingScheduled = true;
      this.addArpeggio(
        start,
        [392, 493.88, 587.33, 783.99],
        0.42,
        0.04,
        { step: 0.1, attack: 0.02, decay: 3 }
      );
      return;
    }
    if (state.over) {
      this.lastOverScheduled = true;
      this.addTone(98, start, 0.6, 0.035, { attack: 0.025 });
      this.addTone(130.81, start + 0.15, 0.5, 0.022, { attack: 0.025 });
      return;
    }
    if (state.lastCommand === "new") {
      this.addArpeggio(start, [261.63, 329.63, 392], 0.2, 0.032, {
        step: 0.075,
        attack: 0.02,
      });
    } else if (state.lastCommand === "undo") {
      this.addArpeggio(start, [349.23, 293.66], 0.22, 0.028, {
        step: 0.09,
        attack: 0.024,
      });
    }
  }

  maybeSchedule(state, nowMs) {
    const commandSeq = Number(state.commandSeq || 0);
    const animation = state.animation;
    const startedAt = animation ? Number(animation.startedAt) : 0;
    const finiteStart =
      Number.isFinite(startedAt) &&
      startedAt > 0 &&
      startedAt < 1e15;

    if (commandSeq !== this.lastCommandSeq) {
      this.lastCommandSeq = commandSeq;
      this.lastAnimationStartedAt = 0;
      this.lastEndingScheduled = false;
      this.lastOverScheduled = false;
      this.pendingMove = null;
      this.pendingNonMove = null;
      if (commandSeq > 0 && !animation) {
        if (this.viewerConnected) {
          this.scheduleNonMove(state, nowMs);
        } else {
          this.pendingNonMove = state;
        }
      }
    }

    if (
      animation &&
      finiteStart &&
      startedAt !== this.lastAnimationStartedAt
    ) {
      this.lastAnimationStartedAt = startedAt;
      this.scheduleMove(state, startedAt, nowMs);
    }

  }

  render(sampleCount, state) {
    const frames = Math.max(0, Math.floor(sampleCount));
    this.maybeSchedule(state, Date.now());
    const buffer = Buffer.allocUnsafe(
      frames * this.channels * 2
    );

    for (let index = 0; index < frames; index += 1) {
      const time = this.time + index / this.sampleRate;
      let value = 0;

      for (const voice of this.voices) {
        const local = time - voice.start;
        if (local < 0 || local > voice.duration) continue;
        const attack = Math.min(
          1,
          local / Math.max(0.004, voice.attack)
        );
        const envelope =
          attack * Math.exp((-voice.decay * local) / voice.duration);
        const frequency =
          voice.freq * (1 + voice.sweep * (local / voice.duration));
        value +=
          Math.sin(TWO_PI * frequency * local) *
          voice.gain *
          envelope;
      }

      const sample = Math.round(
        clampSample(value * this.masterGain) * 32767
      );
      const offset = index * this.channels * 2;
      buffer.writeInt16LE(sample, offset);
      buffer.writeInt16LE(sample, offset + 2);
    }

    this.time += frames / this.sampleRate;
    this.voices = this.voices.filter(
      (voice) => voice.start + voice.duration > this.time - 0.25
    );
    return buffer;
  }
}

module.exports = {
  GameAudio,
  SAMPLE_RATE,
  CHANNELS,
};
