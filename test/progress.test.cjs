const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  clearProgress,
  mediaKeyForLink,
} = require("../server/progress.cjs");

const LINK =
  "2048|http%3A%2F%2F127.0.0.1%3A18081|test-user-123|zh-Hans";

function makeDatabase(mediaKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-2048-progress-"));
  const dbPath = path.join(dir, "rex-kernel.db");
  const sql = [
    "CREATE TABLE playback_progress(mediaKey TEXT, episode INTEGER);",
    "CREATE TABLE resume_candidate(mediaKey TEXT, episode INTEGER);",
    `INSERT INTO playback_progress VALUES('${mediaKey}', 2);`,
    `INSERT INTO playback_progress VALUES('${mediaKey}', 3);`,
    `INSERT INTO resume_candidate VALUES('${mediaKey}', 2);`,
    `INSERT INTO resume_candidate VALUES('${mediaKey}', 3);`,
  ].join("\n");
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  return { dir, dbPath };
}

test("mediaKey accepts a language-qualified link", () => {
  assert.match(mediaKeyForLink(LINK), /^k:script:rex\.2048\.live:[a-f0-9]{32}$/);
  assert.ok(mediaKeyForLink("2048|http%3A%2F%2F127.0.0.1%3A18081|test-user-123"));
});

test("clearProgress deletes the selected episode from a language-qualified link", async () => {
  const mediaKey = mediaKeyForLink(LINK);
  const { dir, dbPath } = makeDatabase(mediaKey);
  try {
    const result = await clearProgress({
      link: LINK,
      episode: 2,
      dbPath,
    });
    assert.equal(result.cleared, true);

    const remaining = execFileSync(
      "sqlite3",
      [
        dbPath,
        "SELECT (SELECT count(*) FROM playback_progress) || ':' || (SELECT count(*) FROM resume_candidate);",
      ],
      { encoding: "utf8" }
    ).trim();
    assert.equal(remaining, "1:1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("progress reset can be disabled for Docker", async () => {
  const previous = process.env.ENABLE_PROGRESS_RESET;
  process.env.ENABLE_PROGRESS_RESET = "0";
  try {
    const result = await clearProgress({ link: LINK, episode: 2 });
    assert.equal(result.cleared, false);
    assert.equal(result.reason, "disabled");
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_PROGRESS_RESET;
    } else {
      process.env.ENABLE_PROGRESS_RESET = previous;
    }
  }
});
