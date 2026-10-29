import { describe, expect, it, vi } from "vitest";
import { unref } from "vue";

const mocks = vi.hoisted(() => ({
  env: { isElectron: true, isMygo: false },
  toggleOutputDevice: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/stores", () => ({ useSettingStore: () => ({}), useStatusStore: () => ({}) }));
vi.mock("@/utils/env", () => mocks.env);
vi.mock("@/platform", () => ({ platform: { capabilities: {} } }));
vi.mock("@/utils/helper", () => ({ renderOption: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { usePlaySettings } from "./play";

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
      mocks.toggleOutputDevice.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      item.value.value = "missing";
      for (let n = 0; n < 10; n++) await Promise.resolve();
      expect(mocks.success).toHaveBeenCalledOnce();
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith("message.output_device_change_failed");
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
});
