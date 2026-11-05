const boardEl = document.querySelector("#board");
const scoreEl = document.querySelector("#score");
const bestEl = document.querySelector("#best");
const seqEl = document.querySelector("#seq");
const statusEl = document.querySelector("#status");
const streamInfoEl = document.querySelector("#streamInfo");
const sessionsEl = document.querySelector("#sessions");
const healthEl = document.querySelector("#health");
const logEl = document.querySelector("#log");
const sessionInput = document.querySelector("#session");

const tokenFromUrl = new URLSearchParams(location.search).get("token");
if (tokenFromUrl) {
  sessionStorage.setItem("rex2048.adminToken", tokenFromUrl);
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState(null, "", cleanUrl);
}
const adminToken = sessionStorage.getItem("rex2048.adminToken") || "";

let sessionId = localStorage.getItem("rex2048.debug.session") || "debug-local-01";
let lastCommandId = null;
let lastEpisode = null;
let lastStreamUrl = null;
let busy = false;
let refreshTimer = null;

sessionInput.value = sessionId;

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${message}\n${logEl.textContent}`.slice(0, 12000);
}

function adminHeaders() {
  return adminToken ? { "X-Admin-Token": adminToken } : {};
}

function tileStyle(value) {
  if (!value) return { background: "#252b36", color: "#2b2620" };
  const colors = {
    2: "#eee4da",
    4: "#ede0c8",
    8: "#f2b179",
    16: "#f59563",
    32: "#f67c5f",
    64: "#f65e3b",
    128: "#edcf72",
    256: "#edcc61",
    512: "#edc850",
    1024: "#edc53f",
    2048: "#edc22e",
  };
  return {
    background: colors[value] || "#3c3a32",
    color: value <= 4 ? "#2b2620" : "#ffffff",
  };
}

function renderBoard(board) {
  boardEl.replaceChildren();
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const value = Number(board?.[row]?.[col] || 0);
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.textContent = value || "";
      Object.assign(cell.style, tileStyle(value));
      boardEl.append(cell);
    }
  }
}

function renderState(data) {
  const state = data.state || {};
  renderBoard(state.board);
  scoreEl.textContent = String(state.score ?? 0);
  bestEl.textContent = String(state.best ?? 0);
  seqEl.textContent = String(state.commandSeq ?? 0);

  const parts = [];
  if (state.cheatEnding) parts.push("最高分结局");
  else if (state.over) parts.push("GAME OVER");
  else if (state.won) parts.push("2048! 继续挑战");
  else parts.push("进行中");
  parts.push(`上一步：${String(state.lastCommand || "new").toUpperCase()}`);
  parts.push(`种子：${state.seed ?? "-"}`);
  parts.push(`会话：${data.sessionId || sessionId}`);
  statusEl.textContent = parts.join(" · ");

  lastStreamUrl = data.streamUrl || lastStreamUrl;
  streamInfoEl.innerHTML = lastStreamUrl
    ? `流地址：<code>${lastStreamUrl}</code>`
    : "流地址：<span class=\"muted\">等待开局</span>";
}

function renderSessions(sessions) {
  sessionsEl.replaceChildren();
  for (const item of sessions || []) {
    const row = document.createElement("div");
    row.className = "session-item";
    const text = document.createElement("span");
    text.textContent = `${item.sessionId} · ${item.score} 分 · ${item.over ? "结束" : "进行中"}`;
    const button = document.createElement("button");
    button.textContent = "选择";
    button.addEventListener("click", () => {
      sessionId = item.sessionId;
      sessionInput.value = sessionId;
      localStorage.setItem("rex2048.debug.session", sessionId);
      refresh();
    });
    row.append(text, button);
    sessionsEl.append(row);
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...adminHeaders(),
      ...(options.headers || {}),
    },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const health = await request("/api/health");
    healthEl.textContent = health.ok
      ? `服务正常 · ${health.activeStreams} 条流`
      : `服务异常 · ffmpeg=${health.ffmpeg} nms=${health.nms}`;
    healthEl.style.color = health.ok ? "var(--accent)" : "var(--danger)";

    const list = await request("/api/sessions");
    renderSessions(list.sessions);

    try {
      const data = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
      renderState(data);
    } catch (error) {
      if (!String(error.message).includes("会话不存在")) throw error;
      renderBoard(Array.from({ length: 4 }, () => Array(4).fill(0)));
      statusEl.textContent = `会话 ${sessionId} 尚未开局，点“1 开局”`;
    }
  } catch (error) {
    healthEl.textContent = `服务不可用：${error.message}`;
    healthEl.style.color = "var(--danger)";
  } finally {
    busy = false;
  }
}

async function send(episode, commandId = null) {
  if (busy) return;
  const id = commandId || `${sessionId}:${episode}:${Date.now()}`;
  busy = true;
  try {
    const body = await request(`/api/sessions/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      body: JSON.stringify({ episode, commandId: id }),
    });
    lastCommandId = id;
    lastEpisode = episode;
    renderState({ ...body, sessionId });
    log(
      `episode=${episode} applied=${body.applied} duplicate=${body.duplicate} ` +
        `command=${body.timings?.commandMs}ms stream=${body.timings?.streamReadyMs}ms`
    );
    await refresh();
  } catch (error) {
    log(`命令失败：${error.message}`);
  } finally {
    busy = false;
  }
}

document.querySelector("#open").addEventListener("click", () => {
  sessionId = sessionInput.value.trim();
  localStorage.setItem("rex2048.debug.session", sessionId);
  lastCommandId = null;
  lastEpisode = null;
  log(`打开会话 ${sessionId}`);
  refresh();
});

for (const button of document.querySelectorAll("[data-episode]")) {
  button.addEventListener("click", () => {
    const episode = Number(button.dataset.episode);
    void send(episode);
  });
}

document.querySelector("#duplicate").addEventListener("click", () => {
  if (!lastCommandId || !lastEpisode) {
    log("还没有可重复的命令");
    return;
  }
  log(`重复发送 ${lastCommandId}`);
  void send(lastEpisode, lastCommandId);
});

document.querySelector("#stream").addEventListener("click", () => {
  if (!lastStreamUrl) {
    log("还没有视频流地址，先点开局");
    return;
  }
  window.open(lastStreamUrl, "_blank", "noopener");
});

refresh();
refreshTimer = setInterval(refresh, 1000);
window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
