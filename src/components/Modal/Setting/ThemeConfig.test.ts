import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { isEmpty, snakeCase } from "lodash-es";
import themeColors from "@/assets/data/themeColor.json";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

function fixture(globalColor: boolean, backgroundMode = "color") {
  const setting = reactive({
    themeGlobalColor: globalColor,
    themeFollowCover: true,
    themeColorType: "default",
    themeCustomColor: "#fe7971",
    themeVariant: "primary",
  });
  const status = reactive({
    themeBackgroundMode: backgroundMode,
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
  const selectVideo = async () => {
    const input = host.all().find((node) => node.tag === "input");
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
  return { setting, status, data, message, globalSwitch, selectVideo, clear };
}

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
