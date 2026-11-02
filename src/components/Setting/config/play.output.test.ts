import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, unref } from "vue";

const mocks = vi.hoisted(() => ({
  env: { isElectron: true, isMygo: false },
  toggleOutputDevice: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  platform: { os: "darwin" },
  settings: { playDevice: "" },
}));
vi.mock("@/stores", () => ({ useSettingStore: () => mocks.settings, useStatusStore: () => ({}) }));
vi.mock("@/utils/env", () => mocks.env);
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/helper", () => ({ renderOption: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { usePlaySettings } from "./play";

afterEach(() => {
  mocks.env.isElectron = true;
  mocks.env.isMygo = false;
  mocks.platform.os = "darwin";
  mocks.settings.playDevice = "";
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
  it("waits for the device switch before reporting success and reports real failure", async () => {
    vi.stubGlobal("window", { $message: mocks });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let resolve: () => void = () => {};
      mocks.toggleOutputDevice.mockImplementationOnce(
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
      expect(mocks.settings.playDevice).toBe("speakers");
      mocks.toggleOutputDevice.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      item.value.value = "missing";
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(mocks.success).toHaveBeenCalledOnce();
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith("message.output_device_change_failed");
      expect(mocks.settings.playDevice).toBe("speakers");
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
  it("requests microphone access only from the macOS read button and coalesces clicks", async () => {
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
    expect(enumerateDevices).toHaveBeenCalledTimes(3);
    expect(mocks.toggleOutputDevice).not.toHaveBeenCalled();
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
    expect(mocks.toggleOutputDevice).not.toHaveBeenCalled();
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
    scope.stop();
    grant({ getTracks: () => [{ stop }] });
    await flush();
    expect(stop).toHaveBeenCalledOnce();
    expect(enumerateDevices).not.toHaveBeenCalled();
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
    "does not offer capture-assisted enumeration outside mygo macOS: $os $electron $mygo",
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
      expect(unref(output?.extraButton?.show)).toBe(false);
      expect(getUserMedia).not.toHaveBeenCalled();
    },
  );
});
