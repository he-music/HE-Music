import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createDefaultDesktopLyricStyle } from "./desktopLyricStyle";
import { createDefaultDesktopLyricOptions } from "./desktopLyricOptions";
vi.stubGlobal("localStorage", {});
const { createSettingState, useSettingStore } = await import("@/stores/setting");
const { createShortcutState, useShortcutStore } = await import("@/stores/shortcut");
const {
  validateSettingState,
  validateShortcutState,
  serializeRendererSettings,
  parseRendererSettings,
  writeRendererSettings,
} = await import("./rendererSettings");

beforeEach(() => setActivePinia(createPinia()));
function storage(failures: number[] = []) {
  const values = new Map([
    ["setting-store", "old-settings"],
    ["shortcut-store", "old-shortcuts"],
  ]);
  let calls = 0;
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      if (failures.includes(++calls)) throw new Error("quota");
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}
const partial = (setting: unknown = {}, shortcut: unknown = {}) => ({
  "setting-store": JSON.stringify(setting),
  "shortcut-store": JSON.stringify(shortcut),
});

describe("rendererSettings", () => {
  it("persists native text options independently and rejects malformed imported font data", () => {
    const setting = useSettingStore();
    const shortcut = useShortcutStore();
    setting.desktopLyricOptions.font.size = 48;
    setting.desktopLyricOptions.showTran = false;
    const saved = serializeRendererSettings(setting.$state, shortcut.$state);
    const decoded = validateSettingState(JSON.parse(saved["setting-store"]));
    expect(decoded.desktopLyricOptions.font.size).toBe(48);
    expect(decoded.desktopLyricOptions.showTran).toBe(false);
    decoded.desktopLyricOptions.font.size = 96;
    expect(setting.desktopLyricOptions.font.size).toBe(48);
    expect(validateSettingState({}).desktopLyricOptions).toEqual(
      createDefaultDesktopLyricOptions(),
    );
    for (const desktopLyricOptions of [
      { font: { size: 97 } },
      { font: { family: "url(private)" } },
      { showYrc: "true" },
      { unknown: 1 },
    ]) {
      expect(() => validateSettingState({ desktopLyricOptions })).toThrow(
        "Invalid renderer settings",
      );
    }
  });
  it("round trips actual current Pinia snapshots and reset defaults", () => {
    const setting = useSettingStore();
    const shortcut = useShortcutStore();
    setting.language = "en";
    const font = {
      family: "合成 Font",
      weight: 425.5,
      style: "Oblique",
      postscriptName: "Synthetic-Variable",
    };
    setting.globalFont = font;
    setting.lyricFont = font;
    setting.lyricsScrollOffset = -0.4;
    setting.monetScrollOffset = -0.2;
    const serialized = serializeRendererSettings(setting.$state, shortcut.$state);
    expect(JSON.parse(serialized["setting-store"])).toEqual(setting.$state);
    expect(parseRendererSettings(serialized)).toEqual(serialized);
    setting.$reset();
    shortcut.$reset();
    expect(setting.$state).toEqual(createSettingState());
    expect(shortcut.$state).toEqual(createShortcutState());
  });
  it("persists desktop style independently and supplies defaults for old settings", () => {
    const setting = useSettingStore();
    const shortcut = useShortcutStore();
    const style = {
      ...createDefaultDesktopLyricStyle(),
      playedColor: "#123456",
      shadowColor: "rgba(1, 2, 3, 0)",
      textBackgroundMask: true,
    };
    setting.desktopLyricStyle = style;
    const saved = serializeRendererSettings(setting.$state, shortcut.$state);
    const decoded = validateSettingState(JSON.parse(saved["setting-store"]));
    expect(decoded.desktopLyricStyle).toEqual(style);
    decoded.desktopLyricStyle.playedColor = "#fff";
    expect(setting.desktopLyricStyle.playedColor).toBe("#123456");
    expect(validateSettingState({}).desktopLyricStyle).toEqual(createDefaultDesktopLyricStyle());
    expect(
      validateSettingState({ desktopLyricStyle: { playedColor: "#123" } }).desktopLyricStyle,
    ).toEqual({ ...createDefaultDesktopLyricStyle(), playedColor: "#123" });
    setting.$reset();
    const first = setting.desktopLyricStyle;
    first.playedColor = "#abc";
    setting.$reset();
    expect(setting.desktopLyricStyle).toEqual(createDefaultDesktopLyricStyle());
    expect(setting.desktopLyricStyle).not.toBe(first);
  });
  it.each<unknown>([
    { playedColor: "url(https://fixture.invalid/private)" },
    { shadowColor: "rgba(0,0,0,2)" },
    { textBackgroundMask: "true" },
    { unknown: false },
    null,
    [],
  ])("rejects malformed persisted desktop style: %j", (desktopLyricStyle) => {
    expect(() => validateSettingState({ desktopLyricStyle })).toThrow("Invalid renderer settings");
  });
  it("fills partial legacy snapshots from defaults without normalizing invalid current enums", () => {
    expect(validateSettingState({ useAMLyrics: true, lyricsScrollOffset: -1 })).toEqual({
      ...createSettingState(),
      lyricRenderer: "amll",
      lyricsScrollOffset: -1,
    });
    expect(validateSettingState({ useAMLyrics: true, lyricRenderer: "monet" }).lyricRenderer).toBe(
      "monet",
    );
    expect(
      validateShortcutState({
        shortcutList: { playNext: { shortcut: "N", globalShortcut: "", isRegistered: true } },
      }).shortcutList.playNext,
    ).toEqual({ shortcut: "N", globalShortcut: "", isRegistered: true });
    expect(validateShortcutState({})).toEqual(createShortcutState());
  });
  it.each<unknown>([
    { themeMode: "invalid" },
    { themeVariant: "invalid" },
    { themeColorType: "invalid" },
    { closeAppMethod: "invalid" },
    { lyricsPosition: "invalid" },
    { kineticJumpGranularity: "invalid" },
    { fileNameFormat: "invalid" },
    { folderStrategy: "invalid" },
    { proxyProtocol: "invalid" },
    { playerType: "invalid" },
    { playerBackgroundType: "invalid" },
    { playerMainColorType: "invalid" },
    { lyricRenderer: "invalid" },
    { routeAnimation: "invalid" },
    { playerExpandAnimation: "invalid" },
    { language: "invalid" },
    { useAMLyrics: "true" },
    { autoPlay: 1 },
    { lyricFontSize: Infinity },
    { proxyPort: "80" },
    { downloadPath: "x".repeat(16385) },
    { localFilesPath: [42] },
    { globalFont: "follow" },
    { lyricFont: "default" },
    { globalFont: { family: "A", weight: "400", style: "normal", postscriptName: "A" } },
    {
      globalFont: {
        family: "A",
        weight: 400,
        style: "normal",
        postscriptName: "A",
        token: "secret",
      },
    },
    { epoch: 1 },
    { account: {} },
    { native: {} },
    { constructor: "bad" },
  ])("rejects invalid setting leaf or unknown key: %j", (value) => {
    expect(() => validateSettingState(value)).toThrow("Invalid renderer settings");
  });
  it.each<unknown>([
    { globalOpen: "yes" },
    { shortcutList: { unknownAction: { shortcut: "A", globalShortcut: "" } } },
    { shortcutList: { playNext: { shortcut: "N" } } },
    { shortcutList: { playNext: { shortcut: "N", globalShortcut: "", isRegistered: "yes" } } },
    { shortcutList: { playNext: { shortcut: "N", globalShortcut: "", secret: "bad" } } },
    { shortcutList: [] },
    null,
  ])("rejects malformed shortcut store: %j", (value) => {
    expect(() => validateShortcutState(value)).toThrow();
  });
  it("rejects an invalid second store before any storage reads or writes", () => {
    const host = storage();
    expect(() =>
      writeRendererSettings(host, partial({ language: "en" }, { globalOpen: "bad" })),
    ).toThrow();
    expect(host.getItem).not.toHaveBeenCalled();
    expect(host.setItem).not.toHaveBeenCalled();
  });
  it("writes exactly two validated renderer keys", () => {
    const host = storage();
    expect(writeRendererSettings(host, partial())).toBe("saved");
    expect([...host.values.keys()]).toEqual(["setting-store", "shortcut-store"]);
    expect(JSON.parse(host.values.get("setting-store")!)).toEqual(createSettingState());
  });
  it("restores both prior values after quota failure", () => {
    const host = storage([2]);
    expect(writeRendererSettings(host, partial())).toBe("restored");
    expect([...host.values.values()]).toEqual(["old-settings", "old-shortcuts"]);
  });
  it("removes a previously absent key on rollback", () => {
    const host = storage([2]);
    host.values.delete("setting-store");
    expect(writeRendererSettings(host, partial())).toBe("restored");
    expect(host.values.has("setting-store")).toBe(false);
  });
  it("reports rollback failure without claiming restoration", () => {
    const host = storage([2, 3]);
    expect(writeRendererSettings(host, partial())).toBe("rollback-failed");
    expect(host.values.get("shortcut-store")).toBe("old-shortcuts");
    expect(host.values.get("setting-store")).not.toBe("old-settings");
  });
});
