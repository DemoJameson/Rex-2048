const { createCanvas } = require("@napi-rs/canvas");
const { commandLabel, stringsFor } = require("./i18n.cjs");
const dinoLayers = require("../assets/rex-dino-layers.json");
const UI_FONT =
  "'Noto Sans CJK SC', 'Hiragino Sans GB', 'Heiti SC', sans-serif";

const DINO_FIN = "#e84c5b";
const DINO_COLORS = {
  k: "#080a11",
  b: "#f39a4c",
  p: DINO_FIN,
  s: "#bd5d25",
  c: "#fff1a6",
  y: "#ffcf3f",
};
const DINO_OUTLINE = "#353a56";

const DINO_FRAMES = {
  rest: ["restBody", "restFins", "restArm", "restEye"],
  breath: ["breathBody", "breathFins", "breathArm", "breathEye"],
  blink: ["restBody", "restFins", "restArm", "eyeHappy"],
  happy: ["restBody", "restFins", "armHappy", "eyeHappy", "mouthSmile"],
  cheer: ["breathBody", "breathFins", "armHappy", "eyeHappy", "mouthSmile"],
  over: ["restBody", "restFins", "restArm", "eyeAngry", "browAngry", "mouthGrit"],
};

function createSilhouette(source, color) {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

function drawExpanded(ctx, source, color) {
  const silhouette = createSilhouette(source, color);
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    ctx.drawImage(silhouette, dx, dy);
  }
}

function colorForLayer(layerName, code) {
  if (layerName.includes("Arm") && code === "c") {
    return DINO_COLORS.y;
  }
  if (layerName === "mouthSmile" && code === "p") {
    return DINO_COLORS.k;
  }
  return DINO_COLORS[code] || null;
}

function createDinoSprite(layerNames) {
  const sprite = createCanvas(64, 64);
  const ctx = sprite.getContext("2d");

  for (const layerName of layerNames) {
    const rows = dinoLayers[layerName] || [];

    for (let row = 0; row < rows.length; row += 1) {
      for (let col = 0; col < rows[row].length; col += 1) {
        const color = colorForLayer(layerName, rows[row][col]);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(col, row, 1, 1);
      }
    }
  }

  const canvas = createCanvas(64, 64);
  const finalCtx = canvas.getContext("2d");
  drawExpanded(finalCtx, sprite, DINO_OUTLINE);
  finalCtx.drawImage(sprite, 0, 0);
  return canvas;
}

const DINO_SPRITES = Object.fromEntries(
  Object.entries(DINO_FRAMES).map(([name, layers]) => [
    name,
    createDinoSprite(layers),
  ])
);

function dinoFrameForState(state, now) {
  const animation = state.animation;
  const animationRunning =
    animation &&
    animation.type === "move" &&
    now >= animation.startedAt &&
    now < animation.startedAt + animation.durationMs;
  const cheatCelebrating =
    Boolean(state.cheatEnding) ||
    (Number(state.cheatAt) > 0 && now - Number(state.cheatAt) < 3000);
  const celebrating =
    state.won ||
    cheatCelebrating ||
    (animationRunning && animation.spawn);

  if (celebrating) {
    return Math.floor(now / 240) % 2 === 0 ? "happy" : "cheer";
  }
  if (state.over) return "over";
  if (now % 4200 < 140) return "blink";
  if (Math.floor(now / 800) % 2 === 0) return "breath";
  return "rest";
}

function displayStatsForState(state, now) {
  const animation = state.animation;
  const animationActive =
    animation &&
    animation.type === "move" &&
    now < animation.startedAt + animation.durationMs;

  if (animationActive) {
    return {
      score: animation.scoreBefore ?? state.score ?? 0,
      best: animation.bestBefore ?? state.best ?? 0,
    };
  }

  return {
    score: state.score ?? 0,
    best: state.best ?? 0,
  };
}

const TILE_COLORS = new Map([
  [2, "#eee4da"],
  [4, "#ede0c8"],
  [8, "#f2b179"],
  [16, "#f59563"],
  [32, "#f67c5f"],
  [64, "#f65e3b"],
  [128, "#edcf72"],
  [256, "#edcc61"],
  [512, "#edc850"],
  [1024, "#edc53f"],
  [2048, "#edc22e"],
  [4096, "#e6b422"],
  [8192, "#f2b179"],
  [16384, "#f59563"],
  [32768, "#f67c5f"],
  [65536, "#f65e3b"],
  [131072, "#edcf72"],
]);

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

function tileColor(value) {
  if (value === 0) return "#252b36";
  return TILE_COLORS.get(value) || "#3c3a32";
}

function tileTextColor(value) {
  return value <= 4 ? "#2b2620" : "#ffffff";
}

function formatNumber(value) {
  return value === 0 ? "" : String(value);
}

function fitTileFontSize(ctx, text, baseSize, maxWidth, minSize = 10) {
  let fontSize = baseSize;
  const widthLimit = Math.max(1, maxWidth);
  const floor = Math.max(1, minSize);

  ctx.font = `800 ${fontSize}px ${UI_FONT}`;
  while (fontSize > floor && ctx.measureText(text).width > widthLimit) {
    fontSize -= 1;
    ctx.font = `800 ${fontSize}px ${UI_FONT}`;
  }
  return fontSize;
}

function createRenderer(options = {}) {
  const width = options.width || 1280;
  const height = options.height || 720;
  const logicalWidth = 960;
  const logicalHeight = 540;
  const scaleX = width / logicalWidth;
  const scaleY = height / logicalHeight;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  function render(state, meta = {}) {
    const language = state.language || "zh-Hans";
    const t = stringsFor(language);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const background = ctx.createLinearGradient(0, 0, logicalWidth, logicalHeight);
    background.addColorStop(0, "#0b0e14");
    background.addColorStop(1, "#161b25");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);

    const boardX = 60;
    const boardY = 60;
    const boardSize = 420;
    const padding = 11;
    const tileSize = 92;
    const gap = 10;
    const step = tileSize + gap;
    const dinoSize = 86;
    const dinoBaseX = 812;
    const dinoBaseY = 350;

    function cellCenter(row, col) {
      return {
        x: boardX + padding + col * step + tileSize / 2,
        y: boardY + padding + row * step + tileSize / 2,
      };
    }

    function drawTile(
      value,
      centerX,
      centerY,
      scale = 1,
      alpha = 1,
      highlight = false
    ) {
      if (!value) return;
      const size = tileSize * scale;
      const x = centerX - size / 2;
      const y = centerY - size / 2;
      if (highlight) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowColor = "#ffd166";
        ctx.shadowBlur = 26 * scale;
        ctx.fillStyle = tileColor(value);
        roundedRect(ctx, x, y, size, size, 12);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tileColor(value);
      roundedRect(ctx, x, y, size, size, 12);
      ctx.fill();
      if (highlight) {
        ctx.strokeStyle = "rgba(255, 225, 150, 0.95)";
        ctx.lineWidth = Math.max(2, 3 * scale);
        roundedRect(ctx, x - 2, y - 2, size + 4, size + 4, 14);
        ctx.stroke();
      }

      const text = formatNumber(value);
      const baseFontSize =
        text.length <= 3 ? 38 : text.length === 4 ? 29 : 23;
      const fontSize = fitTileFontSize(
        ctx,
        text,
        baseFontSize * scale,
        size - 12 * scale,
        10 * scale
      );
      ctx.fillStyle = tileTextColor(value);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, centerX, centerY + 2 * scale);
      ctx.restore();
    }

    function drawEmptySlots() {
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          const center = cellCenter(row, col);
          ctx.fillStyle = "#252b36";
          roundedRect(
            ctx,
            center.x - tileSize / 2,
            center.y - tileSize / 2,
            tileSize,
            tileSize,
            12
          );
          ctx.fill();
        }
      }
    }

    function drawBoard(board) {
      for (let row = 0; row < 4; row += 1) {
        for (let col = 0; col < 4; col += 1) {
          const value = Number(board?.[row]?.[col] || 0);
          const center = cellCenter(row, col);
          if (value > 0) drawTile(value, center.x, center.y);
          else {
            ctx.fillStyle = "#252b36";
            roundedRect(
              ctx,
              center.x - tileSize / 2,
              center.y - tileSize / 2,
              tileSize,
              tileSize,
              12
            );
            ctx.fill();
          }
        }
      }
    }

    function drawDino(state, now) {
      const frame = dinoFrameForState(state, now);
      const celebrating = frame === "happy" || frame === "cheer";

      const size = dinoSize;
      const baseX = dinoBaseX;
      const baseY = dinoBaseY;
      const x = baseX;
      const pulse = celebrating ? 1 + Math.sin(now / 170) * 0.018 : 1;
      const drawWidth = size * pulse;
      const drawHeight = size / pulse;
      const drawX = x + (size - drawWidth) / 2;
      const drawY = baseY + size - drawHeight;

      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
      ctx.beginPath();
      ctx.ellipse(
        x + size / 2,
        baseY + size - 3,
        size * 0.4,
        8,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.beginPath();
      ctx.ellipse(
        x + size / 2,
        baseY + size - 5,
        size * 0.28,
        5,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        DINO_SPRITES[frame],
        drawX,
        drawY,
        drawWidth,
        drawHeight
      );
      ctx.restore();
    }

    ctx.fillStyle = "#111722";
    roundedRect(ctx, boardX, boardY, boardSize, boardSize, 18);
    ctx.fill();

    const animation = state.animation;
    const now = Date.now();
    const animationActive =
      animation &&
      animation.type === "move" &&
      now < animation.startedAt + animation.durationMs;

    if (animationActive) {
      drawEmptySlots();
      const rawProgress = Math.max(
        0,
        Math.min(1, (now - animation.startedAt) / animation.durationMs)
      );
      const progress = 1 - Math.pow(1 - rawProgress, 3);
      const mergeStart = 0.62;
      const merges = Array.isArray(animation.merges)
        ? animation.merges
        : [];
      const mergeKeys = new Set(
        merges.map((merge) => `${merge.row}:${merge.col}`)
      );

      for (const track of animation.tracks || []) {
        const isMergedTrack =
          track.merge && mergeKeys.has(`${track.to.row}:${track.to.col}`);
        if (isMergedTrack && rawProgress >= mergeStart) continue;

        const from = cellCenter(track.from.row, track.from.col);
        const to = cellCenter(track.to.row, track.to.col);
        const scale = isMergedTrack
          ? 1 - 0.08 * Math.min(1, rawProgress / mergeStart)
          : 1;
        drawTile(
          track.value,
          from.x + (to.x - from.x) * progress,
          from.y + (to.y - from.y) * progress,
          scale
        );
      }

      if (merges.length > 0 && rawProgress >= mergeStart) {
        const mergeProgress = Math.min(
          1,
          (rawProgress - mergeStart) / (1 - mergeStart)
        );
        const pop = 1 - Math.pow(1 - mergeProgress, 3);
        const overshoot = Math.sin(mergeProgress * Math.PI) * 0.14;
        const alpha = Math.min(1, mergeProgress * 5);

        for (const merge of merges) {
          const center = cellCenter(merge.row, merge.col);
          drawTile(
            merge.value,
            center.x,
            center.y,
            0.9 + pop * 0.1 + overshoot,
            alpha,
            true
          );

          const ringSize = tileSize * (1.05 + mergeProgress * 0.35);
          ctx.save();
          ctx.globalAlpha = (1 - mergeProgress) * 0.8;
          ctx.strokeStyle = "#ffe29a";
          ctx.lineWidth = 3;
          roundedRect(
            ctx,
            center.x - ringSize / 2,
            center.y - ringSize / 2,
            ringSize,
            ringSize,
            14
          );
          ctx.stroke();
          ctx.restore();
        }
      }

      if (animation.spawn && rawProgress > 0.52) {
        const spawnProgress = Math.min(1, (rawProgress - 0.52) / 0.48);
        const spawn = cellCenter(
          animation.spawn.to.row,
          animation.spawn.to.col
        );
        const pop = 1 - Math.pow(1 - spawnProgress, 3);
        const overshoot = Math.sin(spawnProgress * Math.PI) * 0.12;
        drawTile(
          animation.spawn.value,
          spawn.x,
          spawn.y,
          0.3 + pop * 0.7 + overshoot,
          Math.min(1, spawnProgress * 3),
          true
        );
        if (spawnProgress < 1) {
          const ringSize = tileSize * (1 + spawnProgress * 0.28);
          ctx.save();
          ctx.globalAlpha = (1 - spawnProgress) * 0.8;
          ctx.strokeStyle = "#ffd166";
          ctx.lineWidth = 3;
          roundedRect(
            ctx,
            spawn.x - ringSize / 2,
            spawn.y - ringSize / 2,
            ringSize,
            ringSize,
            14
          );
          ctx.stroke();
          ctx.restore();
        }
      }
    } else {
      drawBoard(state.board);
    }

    const panelX = 540;
    const panelY = 70;
    const panelWidth = 360;

    ctx.fillStyle = "#ffffff";
    ctx.font = `800 34px ${UI_FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("REX 2048", panelX, panelY);

    const scoreY = panelY + 92;
    ctx.fillStyle = "#1b2330";
    roundedRect(ctx, panelX, scoreY, panelWidth, 92, 14);
    ctx.fill();

    ctx.fillStyle = "#8d98aa";
    ctx.font = `700 14px ${UI_FONT}`;
    ctx.fillText(t.score, panelX + 20, scoreY + 16);
    ctx.fillText(t.best, panelX + 200, scoreY + 16);

    ctx.fillStyle = "#ffffff";
    ctx.font = `800 30px ${UI_FONT}`;
    const displayStats = displayStatsForState(state, now);
    ctx.fillText(String(displayStats.score), panelX + 20, scoreY + 40);
    ctx.fillText(String(displayStats.best), panelX + 200, scoreY + 40);

    const statusY = scoreY + 112;
    ctx.fillStyle = "#8d98aa";
    ctx.font = `700 14px ${UI_FONT}`;
    ctx.fillText(t.lastMove, panelX, statusY);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 24px ${UI_FONT}`;
    ctx.fillText(
      commandLabel(meta.lastCommand || state.lastCommand || "new", language),
      panelX,
      statusY + 22
    );

    ctx.fillStyle = "#8d98aa";
    ctx.font = `700 14px ${UI_FONT}`;
    ctx.fillText(t.moveNumber, panelX + 200, statusY);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 24px ${UI_FONT}`;
    ctx.fillText(
      String(state.moveCount ?? meta.moveCount ?? 0),
      panelX + 200,
      statusY + 22
    );

    let status = t.playing;
    let statusColor = "#5ee0a0";
    if (state.cheatEnding) {
      status = t.maxScoreEnding;
      statusColor = "#ffd166";
    } else if (state.over) {
      status = t.gameOver;
      statusColor = "#ff7b7b";
    } else if (state.won) {
      status = t.won;
      statusColor = "#ffd166";
    }

    ctx.fillStyle = statusColor;
    ctx.font = `800 20px ${UI_FONT}`;
    const statusBlockTop = dinoBaseY + dinoSize / 2 - 25;
    ctx.fillText(status, panelX, statusBlockTop);

    ctx.fillStyle = "#6e7a8e";
    ctx.font = `500 14px ${UI_FONT}`;
    ctx.fillText(t.selectEpisode, panelX, statusBlockTop + 36);

    const cheatElapsed = now - Number(state.cheatAt || 0);
    if (Number(state.cheatAt) > 0 && cheatElapsed < 3000) {
      const alpha = Math.min(1, Math.max(0, (3000 - cheatElapsed) / 600));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(8, 10, 17, 0.9)";
      roundedRect(ctx, boardX + 30, boardY + 150, boardSize - 60, 120, 18);
      ctx.fill();
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 4;
      roundedRect(ctx, boardX + 30, boardY + 150, boardSize - 60, 120, 18);
      ctx.stroke();
      ctx.fillStyle = "#ffd166";
      ctx.font = `800 36px ${UI_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t.maxScoreEnding, boardX + boardSize / 2, boardY + 190);
      ctx.fillStyle = "#ff7b9c";
      ctx.font = `700 16px ${UI_FONT}`;
      ctx.fillText(t.maxScoreHint, boardX + boardSize / 2, boardY + 238);
      ctx.restore();
    }

    drawDino(state, now);

    return Buffer.from(
      ctx.getImageData(0, 0, width, height).data.buffer,
      0,
      width * height * 4
    );
  }

  return {
    width,
    height,
    render,
    close() {},
  };
}

module.exports = {
  createRenderer,
  fitTileFontSize,
  dinoFrameForState,
  displayStatsForState,
};
