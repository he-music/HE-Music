import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hct, argbFromHex, themeFromSourceColor } from "@material/material-color-utilities";
import type { CoverColors } from "@/types/main";

const { setting, status, setProperty } = vi.hoisted(() => ({
  setting: { themeGlobalColor: false, themeVariant: "primary" },
  status: { isCustomBackground: false },
  setProperty: vi.fn(),
}));

vi.mock("@/stores", () => ({
  useSettingStore: () => setting,
  useStatusStore: () => status,
}));
vi.mock("@/platform/gateway", () => ({ gatewayProxyUrl: (url: string) => url }));
// 该依赖的入口使用无扩展名的 ESM 导入，Node 测试中仅替换 RGB 序列化。
vi.mock("@imsyy/color-utils", () => ({
  rgbToHex: (r: number, g: number, b: number) =>
    `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
}));
vi.mock("./helper", () => ({
  argbToRgb: (argb: number) => [(argb >> 16) & 255, (argb >> 8) & 255, argb & 255],
}));

import { MONOTONOUS_THEME, setColorSchemes } from "./color";

beforeEach(() => {
  setting.themeGlobalColor = false;
  status.isCustomBackground = false;
  setProperty.mockClear();
  vi.stubGlobal("document", { body: { style: { setProperty } } });
});
afterEach(() => vi.unstubAllGlobals());

function coverTheme(): CoverColors {
  const palette = themeFromSourceColor(argbFromHex("#2196f3")).palettes.primary;
  const rgb = (tone: number) => {
    const argb = palette.tone(tone);
    return { r: (argb >> 16) & 255, g: (argb >> 8) & 255, b: argb & 255 };
  };
  return {
    main: rgb(90),
    light: { primary: rgb(10), background: rgb(94), "surface-container": rgb(90) },
    dark: { primary: rgb(90), background: rgb(20), "surface-container": rgb(16) },
  };
}

describe("局部主题色", () => {
  it.each([
    ["light", 40, "#f6f6f6", "#ffffff"],
    ["dark", 80, "#101014", "#18181c"],
  ] as const)("%s 模式保留中性背景，强调色具有可辨识的色度和明暗", (mode, tone, bg, surface) => {
    const result = setColorSchemes("#2196f3", mode);
    const primary = Hct.fromInt(argbFromHex(result["primary-hex"]));
    expect(primary.tone).toBeCloseTo(tone, 0);
    expect(primary.chroma).toBeGreaterThan(25);
    expect(result["background-hex"]).toBe(bg);
    expect(result["surface-container-hex"]).toBe(surface);
    expect(setProperty).toHaveBeenCalledWith("--primary-hex", result["primary-hex"]);
  });

  it.each(["light", "dark"] as const)("%s 模式切换全局着色不会污染缓存的封面配色", (mode) => {
    const cover = coverTheme();
    const snapshot = structuredClone(cover);
    setting.themeGlobalColor = true;
    const original = setColorSchemes(cover, mode);
    setting.themeGlobalColor = false;
    setColorSchemes(cover, mode);
    expect(cover).toEqual(snapshot);
    setting.themeGlobalColor = true;
    expect(setColorSchemes(cover, mode)).toEqual(original);
  });

  it("纯色预设在局部着色后仍保留原始配色", () => {
    const snapshot = structuredClone(MONOTONOUS_THEME);
    setColorSchemes(MONOTONOUS_THEME, "light");
    setColorSchemes(MONOTONOUS_THEME, "dark");
    expect(MONOTONOUS_THEME).toEqual(snapshot);
  });

  it.each(["light", "dark"] as const)("%s 模式自定义背景临时使用全局配色而不修改偏好", (mode) => {
    const cover = coverTheme();
    setting.themeGlobalColor = true;
    const global = setColorSchemes(cover, mode);
    setting.themeGlobalColor = false;
    status.isCustomBackground = true;
    expect(setColorSchemes(cover, mode)).toEqual(global);
    expect(setting.themeGlobalColor).toBe(false);
    status.isCustomBackground = false;
    expect(setColorSchemes(cover, mode)["background-hex"]).not.toBe(global["background-hex"]);
  });
});
