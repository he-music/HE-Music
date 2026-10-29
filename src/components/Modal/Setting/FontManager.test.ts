import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/stores", () => ({ useSettingStore: () => ({}) }));
import { reactive, toRaw } from "vue";
import * as lodash from "lodash-es";
import defaultLyricConfig from "@/assets/data/lyricConfig";
import { lyricFontConfigs } from "@/utils/lyric/lyricFontConfig";
import * as fontSessions from "@/platform/systemFonts";
import * as optionsModule from "@/platform/desktopLyricOptions";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const provider = { list: vi.fn<() => Promise<string[]>>() };
const platform: { kind: string; systemFonts: typeof provider | undefined } = {
  kind: "mygo",
  systemFonts: provider,
};
const env = { isMygo: true, isElectron: false };
const settings = reactive({
  globalFont: "default",
  desktopLyricOptions: optionsModule.createDefaultDesktopLyricOptions(),
  ...Object.fromEntries(lyricFontConfigs.map((font) => [font.keySetting, font.default])),
});
const message = { error: vi.fn(), success: vi.fn() };
const queryLocalFonts = vi.fn();
const cleanups: Array<() => void> = [];

function mount() {
  const host = mountProductionSfc(
    new URL("./FontManager.vue", import.meta.url),
    {
      "@/stores": { useSettingStore: () => settings },
      "@/platform": { platform },
      "@/platform/systemFonts": fontSessions,
      "@/platform/desktopLyricOptions": optionsModule,
      "@/utils/env": env,
      "@/utils/lyric/lyricFontConfig": { lyricFontConfigs },
      "@/assets/data/lyricConfig": { default: defaultLyricConfig },
      "lodash-es": lodash,
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/helper": { parseFontDataStyle: () => ({ fontWeight: 400, fontStyle: "normal" }) },
    },
    ["NScrollbar", "NH3", "NCard", "NText", "NButton", "NSelect", "NFlex"],
  );
  cleanups.push(host.close);
  return host;
}

beforeEach(() => {
  env.isMygo = true;
  env.isElectron = false;
  platform.kind = "mygo";
  platform.systemFonts = provider;
  settings.globalFont = "default";
  settings.desktopLyricOptions = optionsModule.createDefaultDesktopLyricOptions();
  provider.list.mockResolvedValue(["Demo Family", "Other Family"]);
  vi.stubGlobal("window", { $message: message, queryLocalFonts });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("the production font selectors use native families and save global and desktop lyric choices", async () => {
  settings.desktopLyricOptions.font.family = "Existing Family";
  const previous = structuredClone(toRaw(settings.desktopLyricOptions));
  const host = mount();
  await flushSfcHost();
  expect(provider.list).toHaveBeenCalledOnce();
  expect(queryLocalFonts).not.toHaveBeenCalled();
  const selects = host.all().filter((target) => target.tag === "NSelect");
  expect(selects[0].props.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: "Demo Family", value: "Demo Family" }),
    ]),
  );
  expect(selects[1].props.value).toBe("Existing Family");
  const selected = {
    family: "Demo Family",
    weight: 400,
    style: "normal",
    postscriptName: "Demo Family",
  };
  emitHostEvent(selects[0], "onUpdate:value", "Demo Family", { fontStyleSelection: selected });
  expect(settings.globalFont).toEqual(selected);
  emitHostEvent(selects[1], "onUpdate:value", "Demo Family", { fontStyleSelection: selected });
  expect(settings.desktopLyricOptions).toEqual({
    ...previous,
    font: {
      ...previous.font,
      family: "Demo Family",
      weight: 400,
      style: "normal",
      postScriptName: "Demo Family",
    },
  });
  expect(message.success).toHaveBeenCalledExactlyOnceWith("message.desktop_lyrics_save_success");
});

it("a closed picker rejects its late list while a replacement picker keeps its own families", async () => {
  let finish: (fonts: string[]) => void = () => {
    throw new Error("missing deferred list");
  };
  provider.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = mount();
  old.close();
  const current = mount();
  await flushSfcHost();
  finish(["Retired Family"]);
  await flushSfcHost();
  const select = current.all().find((target) => target.tag === "NSelect");
  expect(select?.props.options).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "Demo Family" })]),
  );
  expect(select?.props.options).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "Retired Family" })]),
  );
  expect(message.error).not.toHaveBeenCalled();
});

it("a native failure retains defaults and reports its localized failure without requesting browser permission", async () => {
  provider.list.mockRejectedValue(new Error("native unavailable"));
  const host = mount();
  await flushSfcHost();
  expect(message.error).toHaveBeenCalledExactlyOnceWith("mygo.fonts.load_failed");
  expect(queryLocalFonts).not.toHaveBeenCalled();
  const select = host.all().find((target) => target.tag === "NSelect");
  expect(select?.props.options).toEqual([{ label: "common.system_default", value: "default" }]);
});

it("the Web picker still uses browser font permission and does not enumerate native fonts", async () => {
  env.isMygo = false;
  platform.kind = "web";
  platform.systemFonts = undefined;
  queryLocalFonts.mockResolvedValue([
    {
      family: "Browser Family",
      fullName: "Browser Family Regular",
      postscriptName: "Browser-Regular",
      style: "Regular",
    },
  ]);
  const host = mount();
  await flushSfcHost();
  expect(queryLocalFonts).toHaveBeenCalledOnce();
  expect(provider.list).not.toHaveBeenCalled();
  const select = host.all().find((target) => target.tag === "NSelect");
  expect(select?.props.options).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: "Browser-Regular" })]),
  );
});
