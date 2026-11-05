const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SessionStore } = require("../server/sessions.cjs");
const {
  createApi,
  normalizePublicBaseUrl,
} = require("../server/api.cjs");

const TEST_ADMIN_TOKEN = ["test", "admin", "token"].join("-");
const moduleFixtureDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "rex2048-api-module-")
);
const moduleFixturePath = path.join(moduleFixtureDir, "rex-2048.js");
fs.writeFileSync(
  moduleFixturePath,
  'const DEFAULT_SERVER = "__REX2048_DEFAULT_SERVER__";\n' +
    'WidgetMetadata = { id: "rex.2048.live", title: "Rex 2048", defaultServer: DEFAULT_SERVER };\n'
);

test.after(() => {
  fs.rmSync(moduleFixtureDir, { recursive: true, force: true });
});

function createFakeStreams() {
  return {
    ensureStream: async (sessionId) => ({
      streamUrl: `http://test.local/live/${sessionId}.flv`,
      readyMs: 1,
    }),
    streamUrl: (sessionId) => `http://test.local/live/${sessionId}.flv`,
    health: () => ({ ffmpeg: true, nms: true, activeStreams: 0, streams: [] }),
  };
}

async function withServer(
  fn,
  streams = createFakeStreams(),
  resetProgress = undefined,
  adminToken = TEST_ADMIN_TOKEN,
  modulePath = moduleFixturePath,
  apiOptions = {}
) {
  const sessions = new SessionStore({ maxSessions: 3, dedupeWindowMs: 2000 });
  const app = createApi({
    sessions,
    streams,
    resetProgress,
    publicDir: path.join(__dirname, "..", "server", "public"),
    adminToken,
    modulePath,
    ...apiOptions,
    publicBaseUrl: apiOptions.publicBaseUrl ?? "",
    trustProxy: apiOptions.trustProxy ?? false,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, sessions });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function adminHeaders(token = TEST_ADMIN_TOKEN) {
  return { "X-Admin-Token": token };
}

async function startFlvUpstream() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "video/x-flv" });
    res.write(Buffer.from("FLV\x01"));
    setTimeout(() => res.end(), 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/live/test.flv`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("public base URL is normalized and must be an origin", () => {
  assert.equal(
    normalizePublicBaseUrl("https://2048.example.com/"),
    "https://2048.example.com"
  );
  assert.equal(
    normalizePublicBaseUrl("http://[2001:db8::1]:18081"),
    "http://[2001:db8::1]:18081"
  );
  assert.equal(normalizePublicBaseUrl(""), "");
  assert.throws(
    () => normalizePublicBaseUrl("https://2048.example.com/rex"),
    /不能包含路径/
  );
});

test("health and debug endpoints are available", async () => {
  await withServer(async ({ base }) => {
    const health = await fetch(`${base}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.streams, undefined);
    const adminHealth = await fetch(`${base}/api/health`, {
      headers: adminHeaders(),
    }).then((res) => res.json());
    assert.ok(Array.isArray(adminHealth.streams));

    const denied = await fetch(`${base}/debug`);
    assert.equal(denied.status, 401);

    const debug = await fetch(`${base}/debug`, {
      headers: adminHeaders(),
    });
    assert.equal(debug.status, 200);
    assert.match(await debug.text(), /Rex 2048 Debug/);

    const poster = await fetch(`${base}/assets/poster.png`);
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get("content-type") || "", /image\/png/);
  });
});

test("landing page and module download are public", async () => {
  await withServer(async ({ base }) => {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") || "", /text\/html/);
    const html = await home.text();
    assert.match(html, /Rex 2048/);
    assert.match(html, /导入到 Rex/);
    assert.match(html, /rex:\/\/widget\?url=/);
    assert.match(html, /\/module\/rex-2048\.js/);

    const head = await fetch(`${base}/module/rex-2048.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(
      head.headers.get("content-type") || "",
      /javascript/
    );

    const module = await fetch(`${base}/module/rex-2048.js`);
    assert.equal(module.status, 200);
    assert.match(
      module.headers.get("cache-control") || "",
      /no-store/
    );
    const code = await module.text();
    assert.match(code, /WidgetMetadata/);
    assert.ok(code.includes(base));
    assert.doesNotMatch(code, /__REX2048_DEFAULT_SERVER__/);
    assert.doesNotMatch(code, /^\s*export\s/m);
  });
});

test("public base URL controls module and stream links", async () => {
  await withServer(
    async ({ base }) => {
      const module = await fetch(`${base}/module/rex-2048.js`);
      const code = await module.text();
      assert.ok(code.includes("https://2048.example.com"));
      assert.doesNotMatch(code, /__REX2048_DEFAULT_SERVER__/);

      const command = await fetch(
        `${base}/api/sessions/test-session-public/command`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episode: 1,
            commandId: "cmd:test-session-public:1:1",
          }),
        }
      ).then((response) => response.json());
      assert.match(
        command.streamUrl,
        /^https:\/\/2048\.example\.com\/stream\//
      );

      const play = await fetch(
        `${base}/api/sessions/test-session-public/play?episode=2`,
        { redirect: "manual" }
      );
      assert.match(
        play.headers.get("location") || "",
        /^https:\/\/2048\.example\.com\/stream\//
      );
    },
    createFakeStreams(),
    undefined,
    TEST_ADMIN_TOKEN,
    moduleFixturePath,
    { publicBaseUrl: "https://2048.example.com/" }
  );
});

test("trusted forwarded host and protocol are used when needed", async () => {
  await withServer(
    async ({ base }) => {
      const module = await fetch(`${base}/module/rex-2048.js`, {
        headers: {
          "X-Forwarded-Host": "edge.example.com",
          "X-Forwarded-Proto": "https",
        },
      });
      const code = await module.text();
      assert.ok(code.includes("https://edge.example.com"));
    },
    createFakeStreams(),
    undefined,
    TEST_ADMIN_TOKEN,
    moduleFixturePath,
    { trustProxy: true }
  );
});

test("forwarded host is ignored without trust proxy", async () => {
  await withServer(async ({ base }) => {
    const module = await fetch(`${base}/module/rex-2048.js`, {
      headers: {
        "X-Forwarded-Host": "untrusted.example.com",
        "X-Forwarded-Proto": "https",
      },
    });
    const code = await module.text();
    assert.ok(code.includes(base));
    assert.doesNotMatch(code, /untrusted\.example\.com/);
  });
});

test("API responses disable CDN caching", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/health`);
    assert.match(
      response.headers.get("cache-control") || "",
      /no-store/
    );
    assert.equal(
      response.headers.get("cdn-cache-control"),
      "no-store"
    );
  });
});

test("stream proxy disables CDN caching and buffering", async () => {
  const upstream = await startFlvUpstream();
  try {
    const streams = {
      ...createFakeStreams(),
      streamUrl: () => upstream.url,
    };
    await withServer(async ({ base }) => {
      const response = await fetch(
        `${base}/stream/test-session-flv/abc.flv`
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "video/x-flv"
      );
      assert.match(
        response.headers.get("cache-control") || "",
        /no-store/
      );
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      assert.equal(
        response.headers.get("cdn-cache-control"),
        "no-store"
      );
      await response.arrayBuffer();
    }, streams);
  } finally {
    await upstream.close();
  }
});

test("module download reports a missing build", async () => {
  await withServer(
    async ({ base }) => {
      const response = await fetch(`${base}/module/rex-2048.js`);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /npm run build/);
    },
    createFakeStreams(),
    undefined,
    TEST_ADMIN_TOKEN,
    path.join(moduleFixtureDir, "missing-rex-2048.js")
  );
});

test("admin endpoints are hidden when no token is configured", async () => {
  await withServer(
    async ({ base }) => {
      const list = await fetch(`${base}/api/sessions`);
      assert.equal(list.status, 404);
      const debug = await fetch(`${base}/debug`);
      assert.equal(debug.status, 404);
      const health = await fetch(`${base}/api/health`).then((res) =>
        res.json()
      );
      assert.equal(health.ok, true);
      assert.equal(health.streams, undefined);
    },
    createFakeStreams(),
    undefined,
    ""
  );
});

test("health reports 503 when ffmpeg or NMS is unavailable", async () => {
  const streams = createFakeStreams();
  streams.health = () => ({
    ffmpeg: false,
    nms: false,
    activeStreams: 0,
    streams: [],
  });
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.ok, false);
  }, streams);
});

test("command applies once and duplicate commandId is idempotent", async () => {
  await withServer(async ({ base, sessions }) => {
    const body = {
      episode: 1,
      commandId: "cmd:test-session-01:1:1",
      language: "zh-Hant",
    };
    const first = await fetch(`${base}/api/sessions/test-session-01/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());
    assert.equal(first.ok, true);
    assert.equal(first.applied, true);
    assert.equal(first.state.language, "zh-Hant");
    assert.match(first.streamUrl, /\/stream\/test-session-01\//);

    const second = await fetch(`${base}/api/sessions/test-session-01/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());
    assert.equal(second.applied, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.state.commandSeq, first.state.commandSeq);

    const stored = sessions.get("test-session-01");
    assert.equal(stored.recentCommands.length, 1);
  });
});

test("move animation starts immediately after the fresh stream is ready", async () => {
  await withServer(async ({ base, sessions }) => {
    const session = sessions.getOrCreate("test-session-delay");
    session.game.board = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    session.game.rng = () => 0;

    const before = Date.now();
    const response = await fetch(
      `${base}/api/sessions/test-session-delay/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 4,
          commandId: "cmd:test-session-delay:4:1",
        }),
      }
    ).then((res) => res.json());
    const after = Date.now();

    assert.equal(response.ok, true);
    assert.equal(response.applied, true);
    assert.ok(session.game.animation);
    assert.ok(session.game.animation.startedAt >= before);
    assert.ok(session.game.animation.startedAt <= after);

    const startedAt = session.game.animation.startedAt;
    await fetch(`${base}/api/sessions/test-session-delay/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode: 4,
        commandId: "cmd:test-session-delay:4:1",
      }),
    });
    assert.equal(session.game.animation.startedAt, startedAt);
  });
});

test("animation is held at the start while the fresh stream is starting", async () => {
  const sessions = new SessionStore({
    maxSessions: 3,
    dedupeWindowMs: 2000,
  });
  const session = sessions.getOrCreate("test-session-hold");
  session.game.board = [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  session.game.rng = () => 0;

  let startedAtDuringEnsure = null;
  const streams = createFakeStreams();
  streams.ensureStream = async (sessionId) => {
    startedAtDuringEnsure =
      sessions.get(sessionId)?.game.animation?.startedAt ?? null;
    return {
      streamUrl: `http://test.local/live/${sessionId}.flv`,
      readyMs: 1,
    };
  };
  const app = createApi({
    sessions,
    streams,
    publicDir: path.join(__dirname, "..", "server", "public"),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const before = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/sessions/test-session-hold/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 4,
          commandId: "cmd:test-session-hold:4:1",
        }),
      }
    ).then((res) => res.json());

    assert.equal(response.ok, true);
    const after = Date.now();
    assert.equal(startedAtDuringEnsure, Number.MAX_SAFE_INTEGER);
    assert.ok(session.game.animation.startedAt >= before);
    assert.ok(session.game.animation.startedAt <= after);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("command is not applied when stream startup fails", async () => {
  const streams = createFakeStreams();
  streams.ensureStream = async () => {
    const error = new Error("等待视频首帧超时");
    error.statusCode = 503;
    throw error;
  };

  await withServer(async ({ base, sessions }) => {
    const response = await fetch(
      `${base}/api/sessions/test-session-fail/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 2,
          commandId: "cmd:test-session-fail:2:1",
        }),
      }
    );
    assert.equal(response.status, 503);
    const stored = sessions.get("test-session-fail");
    assert.ok(stored);
    assert.equal(stored.game.commandSeq, 0);
    assert.equal(stored.recentCommands.length, 0);
  }, streams);
});

test("command resets the 2048 progress key before returning", async () => {
  let resetArgs = null;
  const resetProgress = async (args) => {
    resetArgs = args;
    return { cleared: true, mediaKey: "k:script:rex.2048.live:test" };
  };
  const progressLink =
    "2048|http%3A%2F%2F127.0.0.1%3A18081|test-session-progress|zh-Hans";

  await withServer(
    async ({ base }) => {
      const response = await fetch(
        `${base}/api/sessions/test-session-progress/command`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episode: 2,
            commandId: "cmd:test-session-progress:2:1",
            progressLink,
          }),
        }
      ).then((res) => res.json());
      assert.equal(response.ok, true);
      assert.equal(response.progress.cleared, true);
      assert.deepEqual(resetArgs, {
        link: progressLink,
        episode: 2,
        sessionId: "test-session-progress",
      });
    },
    createFakeStreams(),
    resetProgress
  );
});

test("session query, list and invalid episode are handled", async () => {
  await withServer(async ({ base }) => {
    await fetch(`${base}/api/sessions/test-session-02/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode: 1,
        commandId: "cmd:test-session-02:1:1",
      }),
    });

    const one = await fetch(`${base}/api/sessions/test-session-02`, {
      headers: adminHeaders(),
    }).then((res) => res.json());
    assert.equal(one.ok, true);
    assert.equal(one.state.commandSeq, 1);

    const list = await fetch(`${base}/api/sessions`, {
      headers: adminHeaders(),
    }).then((res) => res.json());
    assert.ok(list.sessions.some((item) => item.sessionId === "test-session-02"));

    const invalid = await fetch(`${base}/api/sessions/test-session-02/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode: 9, commandId: "cmd:test-session-02:9:1" }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("play fallback redirects to the FLV URL", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(
      `${base}/api/sessions/test-session-03/play?episode=2`,
      { redirect: "manual" }
    );
    assert.equal(response.status, 302);
    assert.match(
      response.headers.get("location") || "",
      /\/stream\/test-session-03\//
    );
  });
});

test("play fallback applies undo before redirecting", async () => {
  await withServer(async ({ base, sessions }) => {
    const session = sessions.getOrCreate("test-session-undo");
    session.game.board = [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    session.game.rng = () => 0;

    const moved = await fetch(
      `${base}/api/sessions/test-session-undo/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode: 4,
          commandId: "cmd:test-session-undo:4:1",
        }),
      }
    ).then((res) => res.json());
    assert.equal(moved.applied, true);
    assert.equal(moved.state.commandSeq, 1);

    const response = await fetch(
      `${base}/api/sessions/test-session-undo/play?episode=7&nonce=undo-test-1`,
      { redirect: "manual" }
    );
    assert.equal(response.status, 302);
    assert.match(
      response.headers.get("location") || "",
      /\/stream\/test-session-undo\/undo-test-1\.flv/
    );
    assert.match(
      response.headers.get("cache-control") || "",
      /no-store/
    );

    const state = sessions.get("test-session-undo").game;
    assert.deepEqual(state.board, [
      [2, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    assert.equal(state.score, 0);
    assert.equal(state.lastCommand, "undo");
    assert.equal(state.commandSeq, 2);
    assert.equal(
      sessions.get("test-session-undo").recentCommands.at(-1).command,
      "undo"
    );
  });
});

test("classic Konami episode sequence grants the max-score ending", async () => {
  await withServer(async ({ base, sessions }) => {
    const sequence = [2, 6, 3, 6, 4, 6, 5, 6, 7, 6];
    for (const [index, episode] of sequence.entries()) {
      const response = await fetch(
        `${base}/api/sessions/test-session-cheat/command`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episode,
            commandId: `cmd:test-session-cheat:${index}:${episode}`,
          }),
        }
      );
      assert.equal(response.status, 200);
    }

    const state = sessions.get("test-session-cheat").game;
    assert.equal(state.cheatEnding, true);
    assert.equal(state.score, 3932156);
    assert.equal(state.over, true);
    assert.equal(state.won, true);
  });
});

test("stream proxy validates session IDs", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/stream/bad/nonce.flv`);
    assert.equal(response.status, 400);
  });
});

test("resume returns the current board without applying a command", async () => {
  await withServer(async ({ base, sessions }) => {
    await fetch(`${base}/api/sessions/test-session-resume/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode: 1,
        commandId: "cmd:test-session-resume:1:1",
      }),
    });
    const before = sessions.get("test-session-resume").game.commandSeq;

    const response = await fetch(
      `${base}/api/sessions/test-session-resume/resume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episode: 6, language: "en" }),
      }
    ).then((res) => res.json());

    assert.equal(response.ok, true);
    assert.equal(response.resumed, true);
    assert.equal(response.language, "en");
    assert.equal(response.state.commandSeq, before);
    assert.match(response.streamUrl, /\/stream\/test-session-resume\//);
  });
});

test("episode preview images are distinct and localized", async () => {
  await withServer(async ({ base }) => {
    const first = await fetch(`${base}/assets/episode/1.png?lang=zh-Hans`);
    const second = await fetch(`${base}/assets/episode/2.png?lang=zh-Hans`);
    const english = await fetch(`${base}/assets/episode/2.png?lang=en`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(english.status, 200);
    assert.match(first.headers.get("content-type") || "", /image\/png/);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const secondBytes = Buffer.from(await second.arrayBuffer());
    const englishBytes = Buffer.from(await english.arrayBuffer());
    assert.notDeepEqual(firstBytes, secondBytes);
    assert.notDeepEqual(secondBytes, englishBytes);
  });
});

test("prepare prewarms the stream without applying a command", async () => {
  await withServer(async ({ base, sessions }) => {
    const response = await fetch(`${base}/api/sessions/test-session-04/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    }).then((res) => res.json());
    assert.equal(response.ok, true);
    assert.equal(response.prepared, true);

    const stored = sessions.get("test-session-04");
    assert.equal(stored.game.commandSeq, 0);
    assert.equal(stored.game.lastCommand, "new");
    assert.equal(stored.game.language, "en");
  });
});
