import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", openExternal: vi.fn(async () => {}) },
  create: vi.fn(),
  status: vi.fn(),
  exchange: vi.fn(),
  device: vi.fn(),
}));
vi.mock("./index", () => ({ platform: mocks.platform }));
vi.mock("./mygo.bindings", () => {
  throw new Error("OAuth polling must not load native callback bindings");
});
vi.mock("@/api/auth", () => ({
  createAuthSession: mocks.create,
  getAuthStatus: mocks.status,
  exchangeAuthResult: mocks.exchange,
}));
vi.mock("@/utils/device", () => ({ getDeviceInfo: mocks.device }));
import { createDesktopOAuth } from "./auth";

beforeEach(() => {
  vi.useFakeTimers();
  mocks.device.mockResolvedValue({ app_type: "mygo", device_id: "persisted-device-id" });
  mocks.create.mockResolvedValue({
    url: "https://example.test/auth",
    state: "synthetic",
    check_interval: 2,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  mocks.status.mockResolvedValue({
    status: "success",
    error: "",
    check_interval: 2,
    expires_at: Math.floor(Date.now() / 1000) + 120,
  });
  mocks.exchange.mockResolvedValue({ access_token: "synthetic" });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("desktop OAuth polling bindings", () => {
  it("不传 redirect_uri、不监听本机回调，先查 status 再领取结果", async () => {
    mocks.status.mockResolvedValueOnce({
      status: "pending",
      error: "",
      check_interval: 2,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    });
    const accept = vi.fn(async () => {});
    const error = vi.fn();
    const pending = vi.fn();
    const flow = createDesktopOAuth(accept, error, pending);
    await flow.start("backend-dynamic");
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "backend-dynamic",
        device_info: { app_type: "mygo", device_id: "persisted-device-id" },
      },
      expect.any(AbortSignal),
    );
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("redirect_uri");
    expect(mocks.platform.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://example.test/auth",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith("synthetic", expect.any(AbortSignal));
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(pending.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("synthetic", expect.any(AbortSignal));
    expect(accept).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });

  it("读取设备信息时关闭登录，不再创建后端会话", async () => {
    let resolve!: (value: object) => void;
    mocks.device.mockReturnValueOnce(
      new Promise<object>((done) => {
        resolve = done;
      }),
    );
    const error = vi.fn();
    const flow = createDesktopOAuth(vi.fn(), error);
    const pending = flow.start("provider");
    flow.cancel();
    resolve({ app_type: "mygo" });
    await pending;
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.platform.openExternal).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
