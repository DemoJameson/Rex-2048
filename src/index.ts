import episodes from "../shared/episodes.json";
import i18nData from "../shared/i18n.json";

const DEFAULT_SERVER = "__REX2048_DEFAULT_SERVER__";
const FALLBACK_SERVER = "http://127.0.0.1:18081";
const LINK_PREFIX = "2048";
const STORAGE_KEY = ["rex2048", "local", "session", "v1"].join(".");
const EPISODE_ART_VERSION = "15";

type EpisodeDefinition = {
  episode: number;
  command: string;
  title: string;
  description?: string;
};

type ParsedLink = {
  server: string;
  sessionId: string;
  language: Language;
};

type Language = "zh-Hans" | "en" | "zh-Hant";

const EPISODES = episodes as EpisodeDefinition[];
const I18N = i18nData as {
  defaultLanguage: Language;
  languages: Language[];
  ui: Record<Language, Record<string, string>>;
  episodes: Record<
    string,
    {
      title: Record<Language, string>;
      description: Record<Language, string>;
    }
  >;
};
const DEFAULT_LANGUAGE: Language = "zh-Hans";
const inFlightResources = new Map<string, Promise<any>>();

WidgetMetadata = {
  id: "rex.2048.live",
  title: "Rex 2048",
  version: "0.3.0",
  requiredVersion: "0.0.1",
  description:
    "Rex 2048 是一个把经典数字合并游戏带进 Rex 的实验。棋盘由服务端实时渲染成视频，播放器里的选集面板就是控制器，不需要手柄、键盘映射或额外客户端。",
  author: "DemoJameson",
  site: "https://github.com/DemoJameson/Rex-2048",
  detailCacheDuration: 0,
  i18n: {
    en: {
      "Rex 2048": "Rex 2048",
      "Rex 2048 是一个把经典数字合并游戏带进 Rex 的实验。棋盘由服务端实时渲染成视频，播放器里的选集面板就是控制器，不需要手柄、键盘映射或额外客户端。":
        "Rex 2048 is an experiment that brings the classic number-merging game into Rex. The board is rendered server-side into a real-time video. The episode picker in the player is the controller—no gamepad, keyboard mapping, or extra client required.",
      "服务端地址": "Server URL",
      "界面语言": "Language",
      "2048": "2048",
      "打开后使用播放器内的选集面板操作":
        "Use the player's episode picker to control the board",
      "加载播放资源": "Load stream",
      "简体中文": "Simplified Chinese",
      "English": "English",
      "繁體中文": "Traditional Chinese",
    },
    "zh-Hant": {
      "Rex 2048": "Rex 2048",
      "Rex 2048 是一个把经典数字合并游戏带进 Rex 的实验。棋盘由服务端实时渲染成视频，播放器里的选集面板就是控制器，不需要手柄、键盘映射或额外客户端。":
        "Rex 2048 是一個把經典數字合併遊戲帶進 Rex 的實驗。棋盤由伺服器即時渲染成影片，播放器裡的選集面板就是控制器，不需要手把、鍵盤映射或額外用戶端。",
      "服务端地址": "伺服器位址",
      "界面语言": "介面語言",
      "2048": "2048",
      "打开后使用播放器内的选集面板操作":
        "開啟後使用播放器內的選集面板操作",
      "加载播放资源": "載入播放資源",
      "简体中文": "簡體中文",
      "English": "English",
      "繁體中文": "繁體中文",
    },
  },
  globalParams: [
    {
      name: "server",
      title: "服务端地址",
      type: "input",
      value: defaultServer(),
    },
    {
      name: "language",
      title: "界面语言",
      type: "enumeration",
      value: DEFAULT_LANGUAGE,
      enumOptions: [
        { title: "简体中文", value: "zh-Hans" },
        { title: "English", value: "en" },
        { title: "繁體中文", value: "zh-Hant" },
      ],
    },
  ],
  modules: [
    {
      id: "play2048",
      title: "2048",
      functionName: "loadList",
      description: "打开后使用播放器内的选集面板操作",
      cacheDuration: 0,
      params: [],
    },
    {
      id: "loadResource",
      title: "加载播放资源",
      functionName: "loadResource",
      type: "stream",
      cacheDuration: 0,
      params: [],
    },
  ],
};

function normalizeServer(value: unknown): string {
  const raw = String(value || defaultServer())
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
    throw new Error("服务端地址必须是 http:// 或 https:// URL");
  }
  return raw;
}

function defaultServer(): string {
  return /^https?:\/\//i.test(DEFAULT_SERVER)
    ? DEFAULT_SERVER
    : FALLBACK_SERVER;
}

function getLanguage(value: unknown): Language {
  const raw = String(value || "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.includes("hant") || raw.includes("tw") || raw.includes("hk")) {
    return "zh-Hant";
  }
  return "zh-Hans";
}

function stringsFor(language: Language): Record<string, string> {
  return I18N.ui[language] || I18N.ui[DEFAULT_LANGUAGE];
}

function encodeLink(
  server: string,
  sessionId: string,
  language: Language = DEFAULT_LANGUAGE
): string {
  return `${LINK_PREFIX}|${encodeURIComponent(server)}|${encodeURIComponent(
    sessionId
  )}|${encodeURIComponent(language)}`;
}

function decodeLink(value: unknown): ParsedLink | null {
  if (typeof value !== "string") return null;
  const parts = value.split("|");
  if (
    (parts.length !== 3 && parts.length !== 4) ||
    parts[0] !== LINK_PREFIX
  ) {
    return null;
  }

  try {
    const server = normalizeServer(decodeURIComponent(parts[1]));
    const sessionId = decodeURIComponent(parts[2]);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return null;
    return {
      server,
      sessionId,
      language: getLanguage(parts[3] ? decodeURIComponent(parts[3]) : ""),
    };
  } catch (_error) {
    return null;
  }
}

function randomSessionToken(): string {
  const cryptoObject = (globalThis as any).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return `rex2048-${String(cryptoObject.randomUUID()).replace(/-/g, "")}`;
  }
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    return `rex2048-${Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0")
    ).join("")}`;
  }
  let token = `rex2048-${Date.now().toString(36)}`;
  while (token.length < 40) {
    token += Math.random().toString(36).slice(2);
  }
  return token.slice(0, 40);
}

function getSessionId(): string {
  let stored = "";
  try {
    stored = String(Widget.storage.get(STORAGE_KEY) || "");
  } catch (_error) {
    stored = "";
  }
  if (/^[A-Za-z0-9_-]{8,128}$/.test(stored)) return stored;

  const generated = randomSessionToken();
  try {
    Widget.storage.set(STORAGE_KEY, generated);
  } catch (_error) {
    // Storage is optional for the PoC.
  }
  return generated;
}

function episodeText(
  episode: EpisodeDefinition,
  language: Language,
  field: "title" | "description"
): string {
  return (
    I18N.episodes[String(episode.episode)]?.[field]?.[language] ||
    episode[field] ||
    ""
  );
}

function episodeItems(
  language: Language,
  server: string,
  sessionId: string,
  link: string
) {
  const actionNonce = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  return EPISODES.map((episode) => {
    const image = `${server}/assets/episode/${
      episode.episode
    }.png?lang=${encodeURIComponent(language)}&v=${EPISODE_ART_VERSION}`;
    const item: Record<string, any> = {
      id: `cmd-${episode.episode}`,
      type: "url" as const,
      mediaType: "tv" as const,
      title: episodeText(episode, language, "title"),
      description: episodeText(episode, language, "description"),
      episode: episode.episode,
      episodeNumber: episode.episode,
      duration: 0,
      coverUrl: image,
      posterPath: image,
      backdropPath: image,
    };

    // Episode 7 is the last item in Rex's picker. Some Rex builds only
    // preload the final episode and then reuse that resource, so the
    // loadResource call never receives a command for undo. Give undo a
    // direct action URL as a deterministic fallback; the API applies the
    // undo before redirecting to the live stream.
    if (episode.episode === 7) {
      item.videoUrl = `${server}/api/sessions/${encodeURIComponent(
        sessionId
      )}/play?episode=7&nonce=${encodeURIComponent(
        actionNonce
      )}&lang=${encodeURIComponent(language)}&link=${encodeURIComponent(
        link
      )}`;
    }

    return item;
  });
}

export async function loadList(params: any = {}) {
  try {
    const server = normalizeServer(params.server);
    const sessionId = getSessionId();
    const language = getLanguage(params.language);
    const t = stringsFor(language);
    return [
      {
        id: sessionId,
        type: "url",
        mediaType: "tv",
        title: "Rex 2048",
        description: t.gameDescription,
        coverUrl: `${server}/assets/poster.png?v=${EPISODE_ART_VERSION}`,
        posterPath: `${server}/assets/poster.png?v=${EPISODE_ART_VERSION}`,
        link: encodeLink(server, sessionId, language),
      },
    ];
  } catch (error) {
    console.error("[rex2048] loadList failed:", error);
    throw error;
  }
}

export async function loadDetail(link: string) {
  const parsed = decodeLink(link);
  if (!parsed) return null;
  prepareStream(parsed);
  const t = stringsFor(parsed.language);
  const canonicalLink = encodeLink(
    parsed.server,
    parsed.sessionId,
    parsed.language
  );

  return {
    id: parsed.sessionId,
    type: "url",
    mediaType: "tv",
    title: "Rex 2048",
    description: t.gameDescription,
    coverUrl: `${parsed.server}/assets/poster.png?v=${EPISODE_ART_VERSION}`,
    posterPath: `${parsed.server}/assets/poster.png?v=${EPISODE_ART_VERSION}`,
    backdropPath: `${parsed.server}/assets/poster.png?v=${EPISODE_ART_VERSION}`,
    link: canonicalLink,
    episodeItems: episodeItems(
      parsed.language,
      parsed.server,
      parsed.sessionId,
      canonicalLink
    ),
  };
}

function prepareStream(parsed: ParsedLink) {
  try {
    void Widget.http
      .post(
        `${parsed.server}/api/sessions/${encodeURIComponent(
          parsed.sessionId
        )}/prepare`,
        { language: parsed.language },
        { headers: { "Content-Type": "application/json" } }
      )
      .catch((error) => {
        console.warn("[rex2048] stream prewarm failed:", error);
      });
  } catch (error) {
    console.warn("[rex2048] stream prewarm failed:", error);
  }
}

function buildStreamSource(
  parsed: ParsedLink,
  episodeNumber: number,
  episode: EpisodeDefinition,
  language: Language
) {
  const playbackUrl = `${parsed.server}/stream/${encodeURIComponent(
    parsed.sessionId
  )}/${Date.now()}.flv`;

  const t = stringsFor(language);
  return [
    {
      name: "2048",
      description: `${t.episodeLabel.replace(
        "{n}",
        String(episodeNumber)
      )} · ${episodeText(episode, language, "title")}`,
      url: playbackUrl,
      playerType: "app" as const,
      customHeaders: {
        "X-Forward-Skip-Redirect-Probe": "1",
      },
    },
  ];
}

function parsePlaybackAction(value: unknown): { episode: number; url: string } | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (!/\/api\/sessions\/[^/]+\/play$/.test(url.pathname)) return null;
    const episode = Number(url.searchParams.get("episode"));
    const nonce = String(url.searchParams.get("nonce") || "");
    if (!Number.isInteger(episode) || episode < 1 || episode > 7) return null;
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(nonce)) return null;
    return { episode, url: value };
  } catch (_error) {
    return null;
  }
}

function buildActionSource(
  actionUrl: string,
  episodeNumber: number,
  episode: EpisodeDefinition,
  language: Language
) {
  const t = stringsFor(language);
  const url = new URL(actionUrl);
  url.searchParams.set("request", Date.now().toString(36));

  return [
    {
      name: "2048",
      description: `${t.episodeLabel.replace(
        "{n}",
        String(episodeNumber)
      )} · ${episodeText(episode, language, "title")}`,
      url: url.toString(),
      playerType: "app" as const,
      customHeaders: {
        "X-Forward-Skip-Redirect-Probe": "1",
      },
    },
  ];
}

export async function loadResource(params: any = {}) {
  try {
    const parsed = decodeLink(params.link);
    if (!parsed) {
      console.error("[rex2048] invalid link:", params.link);
      return [];
    }

    const playbackAction = parsePlaybackAction(params.videoUrl);
    const episodeNumber = playbackAction
      ? playbackAction.episode
      : Number(params.episode || 1);
    const episode = EPISODES.find((item) => item.episode === episodeNumber);
    if (!episode) {
      throw new Error(`未知选集：${episodeNumber}`);
    }
    const language = parsed.language;

    if (playbackAction) {
      return buildActionSource(
        playbackAction.url,
        episodeNumber,
        episode,
        language
      );
    }

    const isPreload = /^cmd-/.test(String(params.id || ""));

    if (isPreload) {
      const resourceKey = `${parsed.sessionId}:${episodeNumber}:${String(
        params.id || ""
      )}`;
      const existing = inFlightResources.get(resourceKey);
      if (existing) return await existing;

      const task = (async () => {
        const response = await Widget.http.post(
          `${parsed.server}/api/sessions/${encodeURIComponent(
            parsed.sessionId
          )}/resume`,
          {
            episode: episodeNumber,
            language,
            progressLink: encodeLink(parsed.server, parsed.sessionId, language),
          },
          { headers: { "Content-Type": "application/json" } }
        );
        const data = response && response.data;
        if (!data || !data.streamUrl) {
          throw new Error("服务端未返回播放地址");
        }
        return buildStreamSource(parsed, episodeNumber, episode, language);
      })();

      inFlightResources.set(resourceKey, task);
      try {
        return await task;
      } finally {
        inFlightResources.delete(resourceKey);
      }
    }

    console.log("[rex2048] loadResource params:", {
      episode: params.episode,
      link: params.link,
      season: params.season,
    });

    const task = (async () => {
      const commandId = `${parsed.sessionId}:${episodeNumber}:${Date.now()}`;
      const response = await Widget.http.post(
        `${parsed.server}/api/sessions/${encodeURIComponent(
          parsed.sessionId
        )}/command`,
        {
          episode: episodeNumber,
          commandId,
          language,
          progressLink: encodeLink(parsed.server, parsed.sessionId, language),
        },
        { headers: { "Content-Type": "application/json" } }
      );

      const data = response && response.data;
      if (!data || !data.streamUrl) {
        throw new Error("服务端未返回播放地址");
      }

      return buildStreamSource(parsed, episodeNumber, episode, language);
    })();

    return await task;
  } catch (error) {
    console.error("[rex2048] loadResource failed:", error);
    throw error;
  }
}

