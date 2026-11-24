import { afterEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { h, reactive } from "vue";
import { isEmpty, snakeCase } from "lodash-es";
import themeColors from "@/assets/data/themeColor.json";
import { immersiveSkins, type ImmersiveSkin } from "@/theme/skins";
import { useSettingStore } from "@/stores/setting";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

function fixture(globalColor: boolean, backgroundMode = "color") {
  const setting = useSettingStore(createPinia());
  setting.$patch({
    themeGlobalColor: globalColor,
    themeFollowCover: true,
    themeMode: "auto",
    playerType: "record",
    playerBackgroundType: "blur",
    lyricRenderer: "classic",
    lyricsPosition: "flex-end",
    showPureLyricSongInfo: false,
  });
  const status = reactive({
    themeBackgroundMode: backgroundMode,
    pureLyricMode: true,
    get isCustomBackground() {
      return this.themeBackgroundMode !== "color";
    },
    songCoverTheme: { main: { r: 100, g: 100, b: 100 } },
    backgroundImageUrl: backgroundMode === "color" ? null : "blob:saved",
    backgroundConfig: {
      scale: 1,
      maskColor: "rgba(0,0,0,0.3)",
      blur: 0,
      themeColor: "#2196f3",
      useCustomColor: false,
      customColor: "#fe7971",
      isSolid: false,
    },
  });
  const data = {
    saveBackgroundImage: vi.fn().mockResolvedValue(undefined),
    clearBackgroundImage: vi.fn().mockResolvedValue(undefined),
  };
  const message = { success: vi.fn(), error: vi.fn() };
  vi.stubGlobal("window", { $message: message });
  const host = mountProductionSfc(
    new URL("./ThemeConfig.vue", import.meta.url),
    {
      "@/stores": {
        useSettingStore: () => setting,
        useStatusStore: () => status,
        useDataStore: () => data,
      },
      "@/stores/music": { useMusicStore: () => ({ songCover: "cover.jpg" }) },
      "lodash-es": { isEmpty, snakeCase },
      "@/assets/data/themeColor.json": { default: themeColors },
      "@/utils/color": { getCoverColor: vi.fn(), getCoverColorData: vi.fn() },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/blob": {
        default: { revokeBlobURL: vi.fn(), createBlobURL: () => "blob:background" },
      },
      "@/theme/skins": { immersiveSkins },
      "./SkinPreview.vue": {
        default: (props: Record<string, unknown>) => h("SkinPreview", props),
      },
    },
    [
      "NScrollbar",
      "NCard",
      "NText",
      "NSwitch",
      "NSelect",
      "NButton",
      "NColorPicker",
      "NSlider",
      "SvgIcon",
    ],
    'import { computed, ref } from "vue";',
  );
  cleanups.push(host.close);
  const globalSwitch = () => host.all().find((node) => node.tag === "NSwitch");
  const skinOptions = () => host.all().filter((node) => node.props.type === "radio");
  const selectSkin = async (value: ImmersiveSkin) => {
    const radio = skinOptions().find((node) => node.props.value === value);
    if (!radio) throw new Error("Missing skin option");
    emitHostEvent(radio, "onChange");
    await flushSfcHost();
  };
  const selectVideo = async () => {
    const input = host.all().find((node) => node.props.type === "file");
    if (!input) throw new Error("Missing background file input");
    emitHostEvent(input, "onChange", {
      target: {
        files: [{ size: 100, type: "video/mp4", arrayBuffer: async () => new ArrayBuffer(1) }],
        value: "background.mp4",
      },
    });
    await flushSfcHost();
  };
  const clear = async () => {
    const button = host.all().find((node) => node.tag === "NButton" && node.props.type === "error");
    if (!button) throw new Error("Missing clear background button");
    emitHostEvent(button, "onClick");
    await flushSfcHost();
  };
  return {
    host,
    setting,
    status,
    data,
    message,
    globalSwitch,
    skinOptions,
    selectSkin,
    selectVideo,
    clear,
  };
}

it("在同一个原生单选组显示关闭和注册表中的所有皮肤缩略图", () => {
  const { host, skinOptions } = fixture(false);
  expect(skinOptions().map((node) => [node.props.value, node.props.checked])).toEqual([
    ["none", true],
    ...immersiveSkins.map(({ id }) => [id, false]),
  ]);
  expect(new Set(skinOptions().map((node) => node.props.name)).size).toBe(1);
  for (const radio of skinOptions()) {
    expect(radio.parent?.tag).toBe("label");
    expect(
      host.all(radio.parent ?? radio).find((node) => node.tag === "SkinPreview")?.props.skin,
    ).toBe(radio.props.value);
  }
});

it("选择及关闭沉浸皮肤不会修改播放器样式、背景或歌词设置", async () => {
  const { setting, status, selectSkin } = fixture(false);
  const initialSettings = { ...setting.$state };

  await selectSkin("ice-lake");
  expect(setting.$state).toEqual({ ...initialSettings, immersiveSkin: "ice-lake" });
  expect(status.pureLyricMode).toBe(true);

  await selectSkin("none");
  expect(setting.$state).toEqual(initialSettings);
  expect(status.pureLyricMode).toBe(true);
});

it.each([
  ["ice-lake", "dark"],
  ["apricot-bloom", "light"],
] as const)("切换预设皮肤 %s 时保留现有自定义背景与全局着色偏好", async (skin, mode) => {
  const { setting, status, data, globalSwitch, selectSkin } = fixture(false, "video");
  await selectSkin(skin);
  expect(setting.immersiveSkin).toBe(skin);
  expect(setting.activeSkin?.mode).toBe(mode);
  expect(globalSwitch()).toBeUndefined();
  expect(status.themeBackgroundMode).toBe("video");
  expect(status.backgroundImageUrl).toBe("blob:saved");
  expect(setting.themeGlobalColor).toBe(false);

  await selectSkin("none");
  expect(setting.immersiveSkin).toBe("none");
  expect(globalSwitch()?.props).toMatchObject({ value: true, disabled: true });
  expect(data.clearBackgroundImage).not.toHaveBeenCalled();
});

it.each([false, true])("选择、更换、清除背景后保留全局着色偏好 %s", async (globalColor) => {
  const { setting, status, globalSwitch, selectVideo, clear } = fixture(globalColor);
  await selectVideo();
  expect(status.themeBackgroundMode).toBe("video");
  expect(globalSwitch()?.props).toMatchObject({ value: true, disabled: true });
  expect(setting.themeGlobalColor).toBe(globalColor);
  await selectVideo();
  await clear();
  expect(status.themeBackgroundMode).toBe("color");
  expect(globalSwitch()?.props).toMatchObject({ value: globalColor, disabled: false });
  expect(setting.themeGlobalColor).toBe(globalColor);
});

it.each(["image", "video"])("重新打开设置后退出 %s 背景仍恢复原偏好", async (mode) => {
  const { setting, globalSwitch, clear } = fixture(false, mode);
  expect(globalSwitch()?.props).toMatchObject({ value: true, disabled: true });
  await clear();
  expect(globalSwitch()?.props).toMatchObject({ value: false, disabled: false });
  expect(setting.themeGlobalColor).toBe(false);
});

it("清除背景失败时保留背景和着色状态", async () => {
  const { status, data, message, globalSwitch, clear } = fixture(false, "image");
  data.clearBackgroundImage.mockRejectedValue(new Error("storage unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await clear();
    expect(status.themeBackgroundMode).toBe("image");
    expect(globalSwitch()?.props).toMatchObject({ value: true, disabled: true });
    expect(message.error).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
