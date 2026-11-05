const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const distPath = path.join(__dirname, "..", "dist", "index.js");
const code = fs.readFileSync(distPath, "utf8");
assert.doesNotMatch(code, /^\s*export\s/m, "built widget must not contain export declarations");
assert.match(code, /WidgetMetadata\s*=/);
assert.match(code, /__REX2048_DEFAULT_SERVER__/);
const servedCode = code.replace(
  /["']__REX2048_DEFAULT_SERVER__["']/g,
  JSON.stringify("http://127.0.0.1:18081")
);
assert.doesNotMatch(servedCode, /__REX2048_DEFAULT_SERVER__/);

const posted = [];
const storage = new Map();

global.Widget = {
  http: {
    post: async (url, body) => {
      posted.push({ url, body });
      return {
        data: {
          streamUrl: "http://127.0.0.1:18080/live/test-stream.flv",
        },
      };
    },
  },
  storage: {
    get: (key) => storage.get(key) || null,
    set: (key, value) => storage.set(key, value),
  },
};
global.WidgetMetadata = {};

// The Rex runtime loads the built file as a plain script, not as a module.
// eslint-disable-next-line no-eval
eval(servedCode);

(async () => {
  assert.equal(WidgetMetadata.title, "Rex 2048");
  assert.equal(WidgetMetadata.author, "DemoJameson");
  assert.equal(
    WidgetMetadata.description,
    "Rex 2048 是一个把经典数字合并游戏带进 Rex 的实验。棋盘由服务端实时渲染成视频，播放器里的选集面板就是控制器，不需要手柄、键盘映射或额外客户端。"
  );
  assert.doesNotMatch(JSON.stringify(WidgetMetadata), /直播|Live/);
  assert.equal(
    WidgetMetadata.globalParams[0].value,
    "http://127.0.0.1:18081"
  );

  const defaultList = await loadList();
  assert.equal(
    decodeURIComponent(defaultList[0].link.split("|")[1]),
    "http://127.0.0.1:18081"
  );

  const list = await loadList({
    server: "http://127.0.0.1:18081",
    userId: "test-user-123",
  });
  assert.equal(list.length, 1);
  const sessionId = list[0].id;
  assert.match(sessionId, /^rex2048-[a-f0-9]{32}$/);
  assert.notEqual(sessionId, "test-user-123");
  assert.equal(list[0].type, "url");
  assert.equal(list[0].mediaType, "tv");
  assert.match(list[0].link, /^2048\|/);
  assert.equal(list[0].link.split("|").length, 4);

  const repeatedList = await loadList({
    server: "http://127.0.0.1:18081",
    userId: "another-user-456",
  });
  assert.equal(repeatedList[0].id, sessionId);

  const detail = await loadDetail(list[0].link);
  assert.ok(detail);
  assert.equal(detail.episodeItems.length, 7);
  assert.match(detail.description, /数字合并游戏/);
  assert.match(detail.description, /通过在播放器中选集进行操作/);
  assert.deepEqual(
    detail.episodeItems.map((item) => item.title),
    ["开局", "上", "下", "左", "右", "重复", "撤销"]
  );
  assert.equal(detail.episodeItems[1].videoUrl, undefined);
  assert.match(
    detail.episodeItems[6].videoUrl,
    new RegExp(`/api/sessions/${sessionId}/play\\?episode=7&nonce=`)
  );
  assert.equal(new Set(detail.episodeItems.map((item) => item.coverUrl)).size, 7);
  assert.match(
    detail.episodeItems[1].coverUrl,
    /\/assets\/episode\/2\.png\?lang=zh-Hans&v=15$/
  );

  const commandsBeforeResume = posted.filter((item) =>
    item.url.endsWith("/command")
  ).length;
  const resumed = await loadResource({
    link: detail.link,
    episode: 6,
    id: "cmd-6",
    season: 1,
  });
  assert.equal(resumed.length, 1);
  assert.ok(
    posted.some((item) => item.url.endsWith("/resume")),
    "initial preload should resume the current game"
  );
  assert.equal(
    posted.filter((item) => item.url.endsWith("/command")).length,
    commandsBeforeResume
  );

  const source = await loadResource({
    link: detail.link,
    episode: 2,
    season: 1,
  });
  assert.equal(source.length, 1);
  assert.equal(source[0].name, "2048");
  assert.equal(source[0].playerType, "app");
  assert.match(
    source[0].url,
    new RegExp(
      `^http://127\\.0\\.0\\.1:18081/stream/${sessionId}/\\d+\\.flv$`
    )
  );
  assert.equal(
    source[0].customHeaders["X-Forward-Skip-Redirect-Probe"],
    "1"
  );
  assert.ok(
    posted.some((item) => item.url.endsWith("/prepare")),
    "loadDetail should prewarm the stream"
  );
  const commandPost = posted.find((item) => item.url.endsWith("/command"));
  assert.ok(commandPost);
  assert.equal(
    commandPost.url,
    `http://127.0.0.1:18081/api/sessions/${sessionId}/command`
  );
  assert.equal(commandPost.body.episode, 2);
  assert.match(commandPost.body.commandId, new RegExp(`^${sessionId}:2:`));
  assert.equal(
    commandPost.body.progressLink,
    `2048|http%3A%2F%2F127.0.0.1%3A18081|${sessionId}|zh-Hans`
  );
  assert.equal(commandPost.body.language, "zh-Hans");

  const commandsBeforeAction = posted.filter((item) =>
    item.url.endsWith("/command")
  ).length;
  const actionSource = await loadResource({
    link: detail.link,
    episode: 7,
    id: "cmd-7",
    videoUrl: detail.episodeItems[6].videoUrl,
  });
  assert.equal(actionSource.length, 1);
  assert.match(
    actionSource[0].url,
    new RegExp(
      `^http://127\\.0\\.0\\.1:18081/api/sessions/${sessionId}/play\\?episode=7&nonce=.*&request=`
    )
  );
  assert.equal(
    posted.filter((item) => item.url.endsWith("/command")).length,
    commandsBeforeAction,
    "the undo action URL must be played by Rex instead of being preloaded as a command"
  );

  const englishList = await loadList({
    server: "http://127.0.0.1:18081",
    userId: "test-user-123",
    language: "en",
  });
  const englishDetail = await loadDetail(englishList[0].link);
  assert.ok(englishDetail);
  assert.match(englishDetail.description, /selecting episodes in the player/i);
  assert.deepEqual(
    englishDetail.episodeItems.map((item) => item.title),
    ["New Game", "Up", "Down", "Left", "Right", "Repeat", "Undo"]
  );
  assert.match(englishDetail.link, /\|en$/);

  const traditionalList = await loadList({
    server: "http://127.0.0.1:18081",
    userId: "test-user-123",
    language: "zh-Hant",
  });
  const traditionalDetail = await loadDetail(traditionalList[0].link);
  assert.ok(traditionalDetail);
  assert.match(traditionalDetail.description, /透過在播放器中選集進行操作/);
  assert.deepEqual(
    traditionalDetail.episodeItems.map((item) => item.title),
    ["開局", "上", "下", "左", "右", "重複", "復原"]
  );
  assert.match(traditionalDetail.link, /\|zh-Hant$/);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const commandsBefore = posted.filter((item) =>
    item.url.endsWith("/command")
  ).length;
  const [concurrentA, concurrentB] = await Promise.all([
    loadResource({ link: detail.link, episode: 2, season: 1 }),
    loadResource({ link: detail.link, episode: 2, season: 1 }),
  ]);
  assert.equal(concurrentA.length, 1);
  assert.equal(concurrentB.length, 1);
  assert.equal(
    posted.filter((item) => item.url.endsWith("/command")).length,
    commandsBefore + 2,
    "repeated direction selections must apply every command"
  );

  const commandsBeforePreload = posted.filter((item) =>
    item.url.endsWith("/command")
  ).length;
  const preload = await loadResource({
    link: detail.link,
    episode: 6,
    id: "cmd-6",
    season: 1,
  });
  assert.equal(preload.length, 1);
  assert.equal(
    posted.filter((item) => item.url.endsWith("/command")).length,
    commandsBeforePreload,
    "background episode preloads must not apply commands"
  );

  await new Promise((resolve) => setTimeout(resolve, 1100));
  const commandsBeforeResumeSameEpisode = posted.filter((item) =>
    item.url.endsWith("/command")
  ).length;
  const resumedSameEpisode = await loadResource({
    link: detail.link,
    episode: 2,
    id: "cmd-2",
    season: 1,
  });
  assert.equal(resumedSameEpisode.length, 1);
  assert.equal(
    posted.filter((item) => item.url.endsWith("/command")).length,
    commandsBeforeResumeSameEpisode,
    "reopening and playing the same episode must resume instead of moving"
  );
  assert.ok(
    posted.filter((item) => item.url.endsWith("/resume")).length >= 2,
    "episode preloads and playback should resume the current game"
  );

  assert.equal(await loadDetail("invalid"), null);
  assert.deepEqual(await loadResource({ link: "invalid", episode: 2 }), []);

  console.log("module smoke passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
