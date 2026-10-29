import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deviceName: vi.fn<() => Promise<string>>() }));
vi.mock("@/platform", () => ({ platform: { kind: "mygo", deviceName: mocks.deviceName } }));
vi.mock("./env", () => ({ isElectron: false, isMac: true, isWin: false, isLinux: false }));
import { getDeviceInfo } from "./device";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("uses the native mygo model label while preserving the backend app_type contract and device id", async () => {
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => "persisted-device-id", setItem });
  mocks.deviceName.mockResolvedValue("Mac14,2");
  const info = await getDeviceInfo();
  expect(info).toMatchObject({
    device_id: "persisted-device-id",
    platform: "macos",
    app_type: "web",
    device_name: "Mac14,2",
  });
  expect(mocks.deviceName).toHaveBeenCalledOnce();
  expect(setItem).not.toHaveBeenCalled();
});

it("keeps authentication available if the native model lookup fails", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "persisted-device-id" });
  mocks.deviceName.mockRejectedValue(new Error("native model unavailable"));
  expect(await getDeviceInfo()).toMatchObject({
    device_name: "Mac",
    device_id: "persisted-device-id",
  });
});
