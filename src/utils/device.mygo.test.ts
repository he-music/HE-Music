import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deviceName: vi.fn<() => Promise<string>>() }));
vi.mock("@/platform", () => ({ platform: { kind: "mygo", deviceName: mocks.deviceName } }));
vi.mock("./env", () => ({ isMygo: true, isMac: true, isWin: false, isLinux: false }));
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
    app_type: "mygo",
    device_name: "Mac14,2",
  });
  expect(mocks.deviceName).toHaveBeenCalledOnce();
  expect(setItem).not.toHaveBeenCalled();
});
it("uses mygo for a new desktop device while reusing its generated id", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("crypto", { randomUUID: () => "test-device-uuid" });
  mocks.deviceName.mockResolvedValue("Mac14,2");
  const first = await getDeviceInfo();
  expect(first).toMatchObject({ app_type: "mygo", device_id: "mygo_macos_test-device-uuid" });
  expect((await getDeviceInfo()).device_id).toBe(first.device_id);
});

it("keeps authentication available if the native model lookup fails", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "persisted-device-id" });
  mocks.deviceName.mockRejectedValue(new Error("native model unavailable"));
  expect(await getDeviceInfo()).toMatchObject({
    device_name: "Mac",
    device_id: "persisted-device-id",
  });
});
