import { createSettingState, type SettingState } from "@/stores/setting";
import { migratePlaybackSettings } from "@/utils/playbackSettings";
import { createShortcutState, type ShortcutStore, type ShortcutType } from "@/stores/shortcut";
import type { FontStyleSelection } from "@/types/global";
import type { RendererSettings } from "./mygo.bindings";
import { parseDesktopLyricStyle } from "./desktopLyricStyle";
import { parseDesktopLyricOptions } from "./desktopLyricOptions";

type Reader<T> = (value: unknown) => T;
type Schema<T> = { [K in keyof T]-?: Reader<T[K]> };
const invalid = (): never => {
  throw new Error("Invalid renderer settings");
};
const own = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) return invalid();
    Object.defineProperty(result, key, { value: item, enumerable: true });
  }
  return result;
};
const bool: Reader<boolean> = (value) => (typeof value === "boolean" ? value : invalid());
const number: Reader<number> = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : invalid();
const string: Reader<string> = (value) =>
  typeof value === "string" && value.length <= 16384 ? value : invalid();
const strings: Reader<string[]> = (value) =>
  Array.isArray(value) && value.length <= 4096 ? value.map(string) : invalid();
function enumeration<const T extends string>(...values: T[]): Reader<T> {
  return (value) => values.find((item) => item === value) ?? invalid();
}
function decode<T extends object>(defaults: T, schema: Schema<T>, value: unknown): T {
  const input = object(value);
  if (Object.keys(input).some((key) => !own(schema, key))) return invalid();
  for (const key in defaults) {
    if (own(input, key)) defaults[key] = schema[key](input[key]);
  }
  return defaults;
}
const font: Reader<FontStyleSelection> = (value) => {
  const input = object(value);
  if (Object.keys(input).length !== 4) return invalid();
  return decode(
    { family: "", weight: 400, style: "", postscriptName: "" },
    {
      family: string,
      weight: number,
      style: string,
      postscriptName: string,
    },
    input,
  );
};
const globalFont: Reader<SettingState["globalFont"]> = (value) =>
  value === "default" ? value : font(value);
const lyricFont: Reader<SettingState["lyricFont"]> = (value) =>
  value === "follow" ? value : font(value);

// A mapped schema keeps every current leaf explicit and checks its declared union type.
const settingSchema: Schema<SettingState> = {
  desktopLyricStyle: (value) => parseDesktopLyricStyle(value) ?? invalid(),
  desktopLyricOptions: (value) => parseDesktopLyricOptions(value) ?? invalid(),
  themeMode: enumeration("light", "dark", "auto"),
  themeColorType: enumeration(
    "default",
    "red",
    "pink",
    "purple",
    "deepPurple",
    "indigo",
    "blue",
    "lightBlue",
    "cyan",
    "teal",
    "green",
    "lightGreen",
    "lime",
    "yellow",
    "amber",
    "orange",
    "deepOrange",
    "brown",
    "grey",
    "blueGrey",
    "solid",
    "custom",
  ),
  themeCustomColor: string,
  themeGlobalColor: bool,
  themeFollowCover: bool,
  themeVariant: enumeration(
    "primary",
    "secondary",
    "tertiary",
    "neutral",
    "neutralVariant",
    "error",
  ),
  globalFont,
  lyricFont,
  japaneseLyricFont: lyricFont,
  englishLyricFont: lyricFont,
  koreanLyricFont: lyricFont,
  showCloseAppTip: bool,
  closeAppMethod: enumeration("exit", "hide"),
  showTaskbarProgress: bool,
  useOnlineService: bool,
  checkUpdateOnStart: bool,
  hideVipTag: bool,
  lyricFontSize: number,
  lyricTranFontSize: number,
  lyricRomaFontSize: number,
  lyricFontBold: bool,
  showYrc: bool,
  showYrcAnimation: bool,
  showYrcLongEffect: bool,
  showTran: bool,
  showRoma: bool,
  lyricsPosition: enumeration("flex-start", "center", "flex-end"),
  lyricsScrollOffset: number,
  monetScrollOffset: number,
  showPartitaGuideLines: bool,
  showPartitaUpcoming: bool,
  partitaStagger: number,
  classicWordRotation: bool,
  classicBreathingFloat: number,
  classicWordSpacing: number,
  classicShowUpcoming: bool,
  kineticJumpGranularity: enumeration("auto", "character", "word"),
  downloadPath: string,
  fileNameFormat: enumeration("title", "artist-title", "title-artist"),
  folderStrategy: enumeration("none", "artist", "artist-album"),
  downloadMeta: bool,
  downloadCover: bool,
  downloadLyric: bool,
  downloadLyricTran: bool,
  downloadLyricRoma: bool,
  saveMetaFile: bool,
  downloadKeepAudioOnMetadataFailure: bool,
  proxyProtocol: enumeration("off", "http", "https"),
  proxyServe: string,
  proxyPort: number,
  songLevel: string,
  playDevice: string,
  playbackEngine: enumeration("web-audio", "mpv"),
  preferDownloaded: bool,
  outputDevices: (value) => {
    const input = object(value);
    const device = (value: unknown) =>
      decode({ id: "default", label: "" }, { id: string, label: string }, value);
    if (Object.keys(input).some((key) => key !== "web-audio" && key !== "mpv")) return invalid();
    return { "web-audio": device(input["web-audio"]), mpv: device(input.mpv) };
  },
  autoPlay: bool,
  songVolumeFade: bool,
  songVolumeFadeTime: number,
  useSongUnlock: bool,
  countDownShow: bool,
  barLyricShow: bool,
  autoHidePlayerMeta: bool,
  playerType: enumeration("cover", "record", "fullscreen"),
  playerBackgroundType: enumeration("none", "animation", "blur", "color", "artist-photo"),
  playerBackgroundFps: number,
  playerBackgroundFlowSpeed: number,
  playerMainColorType: enumeration("default", "follow-cover", "follow-theme", "custom"),
  playerMainColorCustom: string,
  memoryLastSeek: bool,
  showPlaylistCount: bool,
  showSpectrums: bool,
  smtcOpen: bool,
  lyricsBlur: bool,
  lrcMousePause: bool,
  showSearchHistory: bool,
  lyricRenderer: enumeration("default", "amll", "monet", "partita", "classic", "kinetic"),
  useAMSpring: bool,
  AMHidePassedLines: bool,
  AMWordFadeWidth: number,
  menuShowCover: bool,
  preventSleep: bool,
  localFilesPath: strings,
  localSeparators: strings,
  showLocalCover: bool,
  routeAnimation: enumeration("none", "fade", "zoom", "slide", "up"),
  playerExpandAnimation: enumeration("up", "flow"),
  useRealIP: bool,
  realIP: string,
  fullPlayerCache: bool,
  useKeepAlive: bool,
  enableOnlineLyricsExclude: bool,
  enableTTMLExclude: bool,
  enableLocalLyricsExclude: bool,
  lyricsExcludeKeywords: strings,
  lyricsExcludeRegexes: strings,
  showDefaultLocalPath: bool,
  showPlayMeta: bool,
  enableTTMLLyrics: bool,
  language: enumeration("zh-CN", "en"),
  registryProtocols: strings,
};
const shortcut: Reader<ShortcutType> = (value) => {
  const input = object(value);
  if (!own(input, "shortcut") || !own(input, "globalShortcut")) return invalid();
  const result = decode<ShortcutType>(
    { shortcut: "", globalShortcut: "" },
    {
      shortcut: string,
      globalShortcut: string,
      isRegistered: bool,
      isPageShortcut: bool,
    },
    input,
  );
  if (own(input, "isRegistered")) result.isRegistered = bool(input.isRegistered);
  if (own(input, "isPageShortcut")) result.isPageShortcut = bool(input.isPageShortcut);
  return result;
};
const shortcutList: Reader<ShortcutStore["shortcutList"]> = (value) =>
  decode(
    createShortcutState().shortcutList,
    {
      playOrPause: shortcut,
      playPrev: shortcut,
      playNext: shortcut,
      volumeUp: shortcut,
      volumeDown: shortcut,
      toggleDesktopLyric: shortcut,
      openPlayer: shortcut,
      openPlayList: shortcut,
      closePlayer: shortcut,
    },
    value,
  );

export function validateSettingState(value: unknown): SettingState {
  const input = object(migratePlaybackSettings(value));
  // This is the only legacy renderer key supported by the existing deserializer.
  if (own(input, "useAMLyrics")) {
    const legacy = bool(input.useAMLyrics);
    const { useAMLyrics: _legacy, ...current } = input;
    void _legacy;
    if (!own(current, "lyricRenderer")) current.lyricRenderer = legacy ? "amll" : "default";
    return decode(createSettingState(), settingSchema, current);
  }
  return decode(createSettingState(), settingSchema, input);
}
export function validateShortcutState(value: unknown): ShortcutStore {
  return decode(createShortcutState(), { globalOpen: bool, shortcutList }, value);
}
export function serializeRendererSettings(setting: unknown, shortcut: unknown): RendererSettings {
  return {
    "setting-store": JSON.stringify(validateSettingState(setting)),
    "shortcut-store": JSON.stringify(validateShortcutState(shortcut)),
  };
}
export function parseRendererSettings(settings: RendererSettings): RendererSettings {
  return serializeRendererSettings(
    JSON.parse(settings["setting-store"]),
    JSON.parse(settings["shortcut-store"]),
  );
}

export type SettingsWriteResult = "saved" | "restored" | "rollback-failed";
/** localStorage has no transaction: restore both previous values on either write failure. */
export function writeRendererSettings(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  settings: RendererSettings,
): SettingsWriteResult {
  // Validate both stores before reading or mutating storage.
  const validated = parseRendererSettings(settings);
  const keys = ["setting-store", "shortcut-store"] as const;
  const previous = keys.map((key) => storage.getItem(key));
  try {
    for (const key of keys) storage.setItem(key, validated[key]);
    return "saved";
  } catch {
    let restored = true;
    keys.forEach((key, index) => {
      try {
        const old = previous[index];
        if (old === null) storage.removeItem(key);
        else storage.setItem(key, old);
      } catch {
        restored = false;
      }
    });
    return restored ? "restored" : "rollback-failed";
  }
}
