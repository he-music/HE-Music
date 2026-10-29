import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toggleOutputDevice: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/stores", () => ({ useSettingStore: () => ({}), useStatusStore: () => ({}) }));
vi.mock("@/utils/env", () => ({ isElectron: true, isMygo: false }));
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
});
