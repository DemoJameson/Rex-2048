const data = require("../shared/i18n.json");
const episodes = require("../shared/episodes.json");

const DEFAULT_LANGUAGE = data.defaultLanguage;
const SUPPORTED_LANGUAGES = data.languages;
const commandToEpisode = new Map(
  episodes.map((episode) => [episode.command, episode.episode])
);

function normalizeLanguage(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.includes("hant") || raw.includes("tw") || raw.includes("hk")) {
    return "zh-Hant";
  }
  return "zh-Hans";
}

function stringsFor(language) {
  const normalized = normalizeLanguage(language);
  return data.ui[normalized] || data.ui[DEFAULT_LANGUAGE];
}

function episodeTitle(episodeNumber, language) {
  const normalized = normalizeLanguage(language);
  return (
    data.episodes[String(episodeNumber)]?.title?.[normalized] ||
    data.episodes[String(episodeNumber)]?.title?.[DEFAULT_LANGUAGE] ||
    ""
  );
}

function episodeDescription(episodeNumber, language) {
  const normalized = normalizeLanguage(language);
  return (
    data.episodes[String(episodeNumber)]?.description?.[normalized] ||
    data.episodes[String(episodeNumber)]?.description?.[DEFAULT_LANGUAGE] ||
    ""
  );
}

function commandLabel(command, language) {
  const episodeNumber = commandToEpisode.get(String(command || ""));
  if (!episodeNumber) return String(command || "").toUpperCase();
  return episodeTitle(episodeNumber, language);
}

module.exports = {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  normalizeLanguage,
  stringsFor,
  episodeTitle,
  episodeDescription,
  commandLabel,
};
