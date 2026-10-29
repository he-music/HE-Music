import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { computed, effectScope, reactive, markRaw, toValue } from "vue";
import { createDefaultDesktopLyricStyle } from "@/platform/desktopLyricStyle";
import { createDefaultDesktopLyricOptions } from "@/platform/desktopLyricOptions";
import type { SettingConfig } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo" },
  session: { ready: { value: true }, window: { value: { locked: true } } },
  player: { toggleDesktopLyric: vi.fn() },
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/platform/desktopLyricsSession", () => ({
  desktopLyricsSession: { value: mocks.session },
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("@/utils/modal", () => ({ openExcludeLyric: vi.fn(), openFontManager: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/Setting/components/LyricPreview.vue", () => ({ default: {} }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  useStatusStore: () => ({ showDesktopLyric: false }),
}));
vi.stubGlobal("localStorage", {});
const { useSettingStore } = await import("@/stores/setting");
const { useLyricSettings } = await import("./lyric");
const scopes: Array<ReturnType<typeof effectScope>> = [];
const success = vi.fn();
const error = vi.fn();
let confirm: (() => unknown) | undefined;
beforeEach(() => {
  setActivePinia(createPinia());
  mocks.platform.kind = "mygo";
  mocks.session.ready.value = true;
  confirm = undefined;
  vi.stubGlobal("computed", computed);
  vi.stubGlobal("reactive", reactive);
  vi.stubGlobal("markRaw", markRaw);
  vi.stubGlobal(
    "window",
    Object.defineProperty(
      {
        $message: { success, error },
        $dialog: {
          warning: (options: { onPositiveClick: () => unknown }) => {
            confirm = options.onPositiveClick;
          },
        },
      },
      "electron",
      {
        get: () => {
          throw new Error("Electron bridge read");
        },
      },
    ),
  );
});
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", {});
});
function config() {
  const scope = effectScope();
  scopes.push(scope);
  const value = scope.run(useLyricSettings);
  if (!value) throw new Error("Missing style config");
  return { value, scope };
}
function item(config: SettingConfig, key: string) {
  const item = config.groups.flatMap((group) => group.items).find((item) => item.key === key);
  if (!item) throw new Error(`Missing ${key}`);
  return item;
}

it("commits colors on completion and only resets the four native style fields", () => {
  const store = useSettingStore();
  const { value } = config();
  const played = item(value, "desktopLyricPlayedColor");
  if (!played.value) throw new Error("Missing color value");
  expect(toValue(played.show)).toBe(true);
  played.value.value = "#123456";
  expect(store.desktopLyricStyle.playedColor).toBe("#fe7971");
  played.action?.();
  expect(store.desktopLyricStyle.playedColor).toBe("#123456");
  const shadow = item(value, "desktopLyricShadowColor");
  if (!shadow.value) throw new Error("Missing shadow value");
  shadow.value.value = "rgba(1, 2, 3, 0)";
  shadow.action?.();
  expect(store.desktopLyricStyle.shadowColor).toBe("rgba(1, 2, 3, 0)");
  const mask = item(value, "desktopLyricTextBackgroundMask");
  if (!mask.value) throw new Error("Missing mask value");
  mask.value.value = true;
  expect(store.desktopLyricStyle.textBackgroundMask).toBe(true);
  item(value, "desktopLyricRestore").action?.();
  if (!confirm) throw new Error("Missing style confirmation");
  confirm();
  expect(store.desktopLyricStyle).toEqual(createDefaultDesktopLyricStyle());
  expect(mocks.session.window.value.locked).toBe(true);
  expect(mocks.player.toggleDesktopLyric).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});

it("reflects imported nested preferences while mounted and releases the scoped watcher", () => {
  const store = useSettingStore();
  const { value, scope } = config();
  const played = item(value, "desktopLyricPlayedColor");
  if (!played.value) throw new Error("Missing color value");
  store.$patch({ desktopLyricStyle: { playedColor: "#abcdef" } });
  expect(played.value.value).toBe("#abcdef");
  scope.stop();
  store.desktopLyricStyle.playedColor = "#fff";
  expect(played.value.value).toBe("#abcdef");
});

it("exposes native display options, retains the Electron font manager and hides Web controls", () => {
  const native = config().value;
  for (const key of [
    "desktopLyricFontSize",
    "desktopLyricPosition",
    "desktopLyricDoubleLine",
    "desktopLyricLimitBounds",
    "desktopLyricShowYrc",
    "desktopLyricShowTran",
    "desktopLyricAnimation",
    "desktopLyricNativeFont",
  ]) {
    expect(toValue(item(native, key).show)).toBe(true);
  }
  expect(toValue(item(native, "desktopLyricFont").show)).toBe(false);
  mocks.platform.kind = "web";
  const web = config().value;
  expect(toValue(item(web, "desktopLyricPlayedColor").show)).toBe(false);
});

it("saves native font and display preferences, rejects invalid input and resets options independently", () => {
  const store = useSettingStore();
  const { value, scope } = config();
  const doubleLine = item(value, "desktopLyricDoubleLine");
  const size = item(value, "desktopLyricFontSize");
  const family = item(value, "desktopLyricNativeFont");
  if (!doubleLine.value || !size.value || !family.value) throw new Error("Missing native options");
  doubleLine.value.value = false;
  size.value.value = 48;
  expect(store.desktopLyricOptions.isDoubleLine).toBe(false);
  expect(store.desktopLyricOptions.font.size).toBe(48);
  family.value.value = "测试字体";
  const blur = family.componentProps?.onBlur;
  if (typeof blur !== "function") throw new Error("No font commit handler");
  blur();
  expect(store.desktopLyricOptions.font.family).toBe("测试字体");
  family.value.value = "url(private)";
  blur();
  expect(store.desktopLyricOptions.font.family).toBe("测试字体");
  expect(family.value.value).toBe("测试字体");
  store.desktopLyricOptions.font.size = 36;
  expect(size.value.value).toBe(36);
  store.desktopLyricStyle.playedColor = "#123456";
  item(value, "desktopLyricOptionsRestore").action?.();
  if (!confirm) throw new Error("No options confirmation");
  confirm();
  expect(store.desktopLyricOptions).toEqual(createDefaultDesktopLyricOptions());
  expect(store.desktopLyricStyle.playedColor).toBe("#123456");
  expect(mocks.session.window.value.locked).toBe(true);
  scope.stop();
  store.desktopLyricOptions.font.size = 80;
  expect(size.value.value).toBe(24);
});

it("keeps an uncommitted font draft when only colors are restored", () => {
  const store = useSettingStore();
  const { value } = config();
  const font = item(value, "desktopLyricNativeFont");
  if (!font.value) throw new Error("Missing font value");
  font.value.value = "测试字体";
  item(value, "desktopLyricRestore").action?.();
  if (!confirm) throw new Error("Missing color reset confirmation");
  confirm();
  expect(font.value.value).toBe("测试字体");
  const blur = font.componentProps?.onBlur;
  if (typeof blur !== "function") throw new Error("Missing font blur handler");
  blur();
  expect(store.desktopLyricOptions.font.family).toBe("测试字体");
});

it("keeps an uncommitted color draft when only text options are restored", () => {
  const store = useSettingStore();
  const { value } = config();
  const played = item(value, "desktopLyricPlayedColor");
  if (!played.value) throw new Error("Missing color value");
  played.value.value = "#123456";
  item(value, "desktopLyricOptionsRestore").action?.();
  if (!confirm) throw new Error("Missing text reset confirmation");
  confirm();
  expect(played.value.value).toBe("#123456");
  played.action?.();
  expect(store.desktopLyricStyle.playedColor).toBe("#123456");
});
