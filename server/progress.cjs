const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const DEFAULT_DB = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Rex",
  "rex-kernel.db"
);
const MEDIA_PREFIX = "k:script:rex.2048.live:";
const LINK_PATTERN =
  /^2048\|[^\s|]+\|[A-Za-z0-9_-]{8,128}(?:\|(?:zh-Hans|en|zh-Hant))?$/;

function progressResetEnabled() {
  const value = String(process.env.ENABLE_PROGRESS_RESET || "").toLowerCase();
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  return process.platform === "darwin";
}

function mediaKeyForLink(link) {
  if (!LINK_PATTERN.test(String(link || ""))) return null;
  const digest = crypto
    .createHash("md5")
    .update(String(link))
    .digest("hex");
  return `${MEDIA_PREFIX}${digest}`;
}

async function clearProgress(options = {}) {
  if (!progressResetEnabled()) {
    return { cleared: false, reason: "disabled" };
  }
  const mediaKey = mediaKeyForLink(options.link);
  const episode = Number(options.episode);
  const dbPath =
    options.dbPath || process.env.REX_KERNEL_DB || DEFAULT_DB;

  if (!mediaKey) return { cleared: false, reason: "invalid-link" };
  if (!Number.isInteger(episode) || episode < 1 || episode > 7) {
    return { cleared: false, reason: "invalid-episode" };
  }
  if (!fs.existsSync(dbPath)) {
    return { cleared: false, reason: "db-missing", mediaKey };
  }

  const sql = [
    "PRAGMA busy_timeout=1500;",
    `DELETE FROM playback_progress WHERE mediaKey = '${mediaKey}' AND episode = ${episode};`,
    `DELETE FROM resume_candidate WHERE mediaKey = '${mediaKey}' AND episode = ${episode};`,
  ].join("\n");

  try {
    await execFileAsync(process.env.SQLITE3_BIN || "sqlite3", [dbPath, sql], {
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return { cleared: true, mediaKey };
  } catch (error) {
    return {
      cleared: false,
      reason: error.message,
      mediaKey,
    };
  }
}

module.exports = {
  DEFAULT_DB,
  mediaKeyForLink,
  clearProgress,
  progressResetEnabled,
};
