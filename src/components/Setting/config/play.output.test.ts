import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, unref, reactive } from "vue";

const mocks = vi.hoisted(() => ({
  env: { isElectron: true, isMygo: false },
  changePlaybackOutput: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  platform: { os: "darwin", mpvPlayback: { initialize: vi.fn(), getOutputDevices: vi.fn() } },
  settings: {
    playDevice: "",
    playbackEngine: "web-audio",
    outputDevices: { "web-audio": { id: "default", label: "" }, mpv: { id: "default", label: "" } },
  },
}));
vi.mock("@/stores", () => ({ useSettingStore: () => mocks.settings, useStatusStore: () => ({}) }));
vi.mock("@/utils/env", () => mocks.env);
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/helper", () => ({ renderOption: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { usePlaySettings } from "./play";

mocks.settings = reactive(mocks.settings);
afterEach(() => {
  mocks.env.isElectron = true;
  mocks.env.isMygo = false;
  mocks.platform.os = "darwin";
  mocks.settings.playDevice = "";
  mocks.settings.playbackEngine = "web-audio";
  mocks.settings.outputDevices = {
    "web-audio": { id: "default", label: "" },
    mpv: { id: "default", label: "" },
  };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}

function mygoOutputConfig() {
  mocks.env.isElectron = false;
  mocks.env.isMygo = true;
  const config = usePlaySettings();
  const output = config.groups
    .flatMap((group) => group.items)
    .find((item) => item.key === "playDevice");
  if (!output) throw new Error("missing output device setting");
  return { config, output };
}

function deviceSetting() {
  const config = usePlaySettings();
  for (const section of config.groups) {
    const item = section.items.find((item) => item.key === "playDevice");
    if (item) return item;
  }
  throw new Error("missing output device setting");
}

describe("output device feedback", () => {
  it("Windows 远程会话没有麦克风时仍保留并可选择远程输出", async () => {
    mocks.platform.os = "win32";
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Requested device not found", "NotFoundError");
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: "audiooutput", deviceId: "default", groupId: "", label: "" },
          { kind: "audiooutput", deviceId: "remote", groupId: "remote", label: "" },
        ]),
        getUserMedia,
      },
    });
    vi.stubGlobal("window", { $message: mocks });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    output.extraButton?.action();
    await flush();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(unref(output.disabled)).toBe(false);
    expect(unref(output.options)).toEqual([
      { label: "common.system_default", value: "" },
      { label: "setting.play.output_device 1", value: "remote" },
    ]);
    if (!output.value) throw new Error("missing output setting");
    output.value.value = "remote";
    await flush();
    expect(mocks.settings.outputDevices["web-audio"].id).toBe("remote");
    expect(mocks.changePlaybackOutput).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledOnce();
  });
  it("Linux WebView 不支持设备枚举时保留系统默认输出，不报读取失败", async () => {
    mocks.platform.os = "linux";
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { $message: mocks });
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    expect(unref(output.options)).toEqual([{ label: "common.system_default", value: "" }]);
    expect(unref(output.extraButton?.show)).toBe(false);
    expect(unref(output.value)).toBe("");
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.changePlaybackOutput).not.toHaveBeenCalled();
  });
  it("WebView 明确拒绝设备枚举时保留已选设备，不影响默认输出", async () => {
    mocks.platform.os = "linux";
    mocks.settings.outputDevices["web-audio"] = { id: "saved", label: "Saved speaker" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => {
          throw new DOMException("Unavailable", "NotSupportedError");
        }),
      },
    });
    vi.stubGlobal("window", { $message: mocks });
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    expect(unref(output.options)).toEqual([
      { label: "common.system_default", value: "" },
      { label: "Saved speaker (mygo.audio.unavailable)", value: "saved", disabled: true },
    ]);
    expect(unref(output.extraButton?.show)).toBe(false);
    expect(mocks.settings.outputDevices["web-audio"].id).toBe("saved");
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.changePlaybackOutput).not.toHaveBeenCalled();
  });
  it("mpv 枚举不请求麦克风，保留失效设备与名称", async () => {
    vi.stubGlobal("window", { $message: mocks });
    const capture = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: capture } });
    mocks.settings.playbackEngine = "mpv";
    mocks.settings.outputDevices.mpv = { id: "missing", label: "Headphones" };
    mocks.platform.mpvPlayback.initialize.mockResolvedValue({ lifecycle: 8 });
    mocks.platform.mpvPlayback.getOutputDevices.mockResolvedValue([
      { id: "auto", label: "Default", available: true },
    ]);
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    expect(capture).not.toHaveBeenCalled();
    expect(mocks.platform.mpvPlayback.getOutputDevices).toHaveBeenCalledWith(8);
    expect(unref(output.options)).toContainEqual({
      value: "missing",
      label: "Headphones (mygo.audio.unavailable)",
      disabled: true,
    });
    expect(mocks.settings.outputDevices.mpv.id).toBe("missing");
  });
  it("引擎切换失败保留新引擎与另一引擎的设备", async () => {
    vi.stubGlobal("window", { $message: mocks });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.settings.outputDevices["web-audio"] = { id: "speaker", label: "Speaker" };
    mocks.platform.mpvPlayback.initialize.mockResolvedValue({ lifecycle: 8 });
    mocks.platform.mpvPlayback.getOutputDevices.mockResolvedValue([]);
    mocks.changePlaybackOutput.mockRejectedValueOnce(new Error("library"));
    const { config } = mygoOutputConfig();
    const engine = config.groups
      .flatMap((group) => group.items)
      .find((item) => item.key === "playbackEngine");
    if (!engine?.value) throw new Error("missing engine setting");
    engine.value.value = "mpv";
    await flush();
    expect(mocks.settings.playbackEngine).toBe("mpv");
    expect(mocks.settings.outputDevices["web-audio"].id).toBe("speaker");
    expect(mocks.error).toHaveBeenCalledWith("mygo.audio.engine_change_failed");
  });
  it("waits for the device switch before reporting success and reports real failure", async () => {
    vi.stubGlobal("window", { $message: mocks });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let resolve: () => void = () => {};
      mocks.changePlaybackOutput.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const item = deviceSetting();
      if (!item.value) throw new Error("missing device binding");
      item.value.value = "speakers";
      expect(mocks.success).not.toHaveBeenCalled();
      resolve();
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(mocks.success).toHaveBeenCalledOnce();
      expect(mocks.settings.outputDevices["web-audio"].id).toBe("speakers");
      mocks.changePlaybackOutput.mockRejectedValueOnce(
        new DOMException("denied", "NotAllowedError"),
      );
      item.value.value = "missing";
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(mocks.success).toHaveBeenCalledOnce();
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith("message.output_device_change_failed");
      expect(mocks.settings.outputDevices["web-audio"].id).toBe("missing");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
  it("exposes desktop playback settings and enumerates mygo outputs with a system default", async () => {
    mocks.env.isElectron = false;
    mocks.env.isMygo = true;
    const enumerateDevices = vi.fn(async () => [
      { kind: "audiooutput", deviceId: "default", groupId: "default", label: "Default" },
      { kind: "audiooutput", deviceId: "speaker", groupId: "", label: "Speaker" },
      { kind: "audiooutput", deviceId: "headset", groupId: "", label: "Headset" },
      { kind: "audioinput", deviceId: "microphone", groupId: "", label: "Microphone" },
    ]);
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
    try {
      const config = usePlaySettings();
      const items = config.groups.flatMap((group) => group.items);
      const autoPlay = items.find((item) => item.key === "autoPlay");
      const output = items.find((item) => item.key === "playDevice");
      expect(autoPlay?.show).toBe(true);
      expect(autoPlay?.disabled).toBe(false);
      expect(output?.show).toBe(true);
      expect(items.find((item) => item.key === "songVolumeFade")?.show).not.toBe(false);
      await config.onActivate?.();
      expect(enumerateDevices).toHaveBeenCalledOnce();
      expect(unref(output?.options)).toEqual([
        { label: "common.system_default", value: "" },
        { label: "Speaker", value: "speaker" },
        { label: "Headset", value: "headset" },
      ]);
    } finally {
      mocks.env.isElectron = true;
      mocks.env.isMygo = false;
      vi.unstubAllGlobals();
    }
  });
  it.each(["darwin", "win32", "linux"])("authorizes restricted outputs on %s", async (os) => {
    mocks.platform.os = os;
    const stop = vi.fn();
    let grant: (stream: { getTracks(): { stop(): void }[] }) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise<{ getTracks(): { stop(): void }[] }>((resolve) => {
          grant = resolve;
        }),
    );
    const enumerateDevices = vi.fn(async () =>
      getUserMedia.mock.calls.length
        ? [{ kind: "audiooutput", deviceId: "speaker", groupId: "", label: "Speaker" }]
        : [{ kind: "audioinput", deviceId: "", groupId: "", label: "" }],
    );
    vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices, getUserMedia } });
    vi.stubGlobal("window", { $message: mocks });
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(unref(output.extraButton?.show)).toBe(true);
    output.extraButton?.action();
    output.extraButton?.action();
    await flush();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    expect(unref(output.disabled)).toBe(true);
    grant({ getTracks: () => [{ stop }] });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(unref(output.options)).toEqual([
      { label: "common.system_default", value: "" },
      { label: "Speaker", value: "speaker" },
    ]);
    expect(unref(output.disabled)).toBe(false);
    output.extraButton?.action();
    await flush();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(4);
    expect(mocks.changePlaybackOutput).not.toHaveBeenCalled();
  });

  it("reports permission denial without changing the saved output", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: vi.fn(async () => []), getUserMedia },
    });
    vi.stubGlobal("window", { $message: mocks });
    mocks.settings.playDevice = "remembered";
    const { config, output } = mygoOutputConfig();
    await config.onActivate?.();
    output.extraButton?.action();
    await flush();
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith("mygo.audio.output_access_denied");
    expect(mocks.settings.playDevice).toBe("remembered");
    expect(mocks.changePlaybackOutput).not.toHaveBeenCalled();
    expect(unref(output.disabled)).toBe(false);
  });

  it("reports an empty authorized device list and releases capture", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })),
      },
    });
    vi.stubGlobal("window", { $message: mocks });
    const { output } = mygoOutputConfig();
    output.extraButton?.action();
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith("mygo.audio.output_devices_empty");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("stops late capture and suppresses feedback after its settings scope is disposed", async () => {
    const stop = vi.fn();
    let grant: (stream: { getTracks(): { stop(): void }[] }) => void = () => {};
    const enumerateDevices = vi.fn(async () => []);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices,
        getUserMedia: vi.fn(
          () =>
            new Promise<{ getTracks(): { stop(): void }[] }>((resolve) => {
              grant = resolve;
            }),
        ),
      },
    });
    vi.stubGlobal("window", { $message: mocks });
    const scope = effectScope();
    const result = scope.run(mygoOutputConfig);
    if (!result) throw new Error("missing settings scope");
    result.output.extraButton?.action();
    await flush();
    scope.stop();
    grant({ getTracks: () => [{ stop }] });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(unref(result.output.options)).toEqual([{ label: "common.system_default", value: "" }]);
  });

  it.each([
    { electron: false, mygo: false, os: "darwin" },
    { electron: true, mygo: false, os: "darwin" },
    { electron: false, mygo: true, os: "win32" },
    { electron: false, mygo: true, os: "linux" },
  ])(
    "does not request capture on activation: $os $electron $mygo",
    async ({ electron, mygo, os }) => {
      mocks.env.isElectron = electron;
      mocks.env.isMygo = mygo;
      mocks.platform.os = os;
      const getUserMedia = vi.fn();
      vi.stubGlobal("navigator", {
        mediaDevices: { enumerateDevices: vi.fn(async () => []), getUserMedia },
      });
      const config = usePlaySettings();
      const output = config.groups
        .flatMap((group) => group.items)
        .find((item) => item.key === "playDevice");
      await config.onActivate?.();
      expect(unref(output?.extraButton?.show)).toBe(mocks.env.isMygo);
      expect(getUserMedia).not.toHaveBeenCalled();
    },
  );
});
