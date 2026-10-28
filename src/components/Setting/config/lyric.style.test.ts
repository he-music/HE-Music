import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { computed, effectScope, reactive, markRaw, toValue } from "vue";
import { createDefaultDesktopLyricStyle } from "@/platform/desktopLyricStyle";
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

it("keeps unsupported options and web style controls hidden", () => {
  const native = config().value;
  for (const key of ["desktopLyricFontSize", "desktopLyricPosition", "desktopLyricDoubleLine"]) {
    expect(toValue(item(native, key).show)).toBe(false);
  }
  mocks.platform.kind = "web";
  const web = config().value;
  expect(toValue(item(web, "desktopLyricPlayedColor").show)).toBe(false);
});
