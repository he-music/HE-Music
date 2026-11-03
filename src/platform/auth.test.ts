import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", openExternal: vi.fn(async () => {}) },
  native: { prepare: vi.fn(), arm: vi.fn(), cancel: vi.fn() },
  on: vi.fn(),
  create: vi.fn(),
  exchange: vi.fn(),
  device: vi.fn(async () => ({})),
}));
vi.mock("./index", () => ({ platform: mocks.platform }));
vi.mock("./mygo.bindings", () => ({
  AuthCallback: mocks.native,
  events: { desktopAuthCallback: { on: mocks.on } },
}));
vi.mock("@/api/auth", () => ({
  createAuthSession: mocks.create,
  exchangeAuthResult: mocks.exchange,
}));
vi.mock("@/utils/device", () => ({ getDeviceInfo: mocks.device }));
import { createDesktopOAuth } from "./auth";
import type { AuthCallbackEvent } from "./oauthFlow";
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe("desktop auth bindings", () => {
  it.each(["mygo"])("%s接入实际流程且只退订自身事件", async (kind) => {
    mocks.platform.kind = kind;
    const off = vi.fn();
    const ipcOn = vi.fn().mockReturnValue(off);
    vi.stubGlobal("window", { electron: { ipcRenderer: { on: ipcOn } } });
    mocks.on.mockReturnValue(off);
    mocks.native.prepare.mockResolvedValue({
      sessionId: "native-session",
      callbackUrl: "http://127.0.0.1:25666/login/success",
    });
    mocks.native.arm.mockResolvedValue(undefined);
    mocks.native.cancel.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({
      url: "https://example.test/auth",
      state: "synthetic",
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    mocks.exchange.mockResolvedValue({ access_token: "synthetic" });
    const accept = vi.fn(async () => {});
    const error = vi.fn();
    const flow = createDesktopOAuth(accept, error);
    await flow.start("backend-dynamic");
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      provider: "backend-dynamic",
      redirect_uri: "http://127.0.0.1:25666/login/success",
    });
    expect(mocks.native.prepare).toHaveBeenCalledWith(0);
    const listener: (event: AuthCallbackEvent) => void = mocks.on.mock.calls[0][0];
    listener({ sessionId: "wrong", state: "synthetic" });
    expect(mocks.exchange).not.toHaveBeenCalled();
    listener({ sessionId: "native-session", state: "synthetic" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(accept).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
});
