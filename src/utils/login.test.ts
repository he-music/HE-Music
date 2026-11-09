import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  data: {
    token: "",
    refreshToken: "",
    expiresAt: 0,
    userLoginStatus: false,
    resetIdentityCaches: vi.fn(),
  },
  platform: { loadPlatforms: vi.fn() },
  status: { playLoading: true },
  setting: { autoPlay: false },
  update: vi.fn(),
  player: { initPlayer: vi.fn(), getSeek: () => 12 },
}));
vi.mock("@/stores", () => ({
  useDataStore: () => mocks.data,
  usePlatformStore: () => mocks.platform,
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.setting,
}));
vi.mock("./auth", () => ({ updateUserData: mocks.update }));
vi.mock("./player", () => ({ usePlayer: () => mocks.player }));
import { completeLogin, finishWebOAuth } from "./login";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue(undefined);
  mocks.platform.loadPlatforms.mockResolvedValue(undefined);
  Object.assign(mocks.data, { token: "", refreshToken: "", expiresAt: 0, userLoginStatus: false });
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
describe("completeLogin", () => {
  it.each(["password", "qr", "oauth"])("%s 共用凭据/用户/平台/播放器完成入口", async (kind) => {
    const result =
      kind === "qr"
        ? { token: "synthetic", refresh_token: "refresh", expires_at: 123 }
        : { access_token: "synthetic", refresh_token: "refresh", expires_at: 123 };
    const completion = completeLogin(result);
    expect(mocks.data).toEqual({
      token: "synthetic",
      refreshToken: "refresh",
      expiresAt: 123,
      userLoginStatus: true,
      resetIdentityCaches: mocks.data.resetIdentityCaches,
    });
    await completion;
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.data.resetIdentityCaches).toHaveBeenCalledOnce();
    expect(mocks.data.resetIdentityCaches.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.platform.loadPlatforms.mock.invocationCallOrder[0],
    );
    expect(mocks.platform.loadPlatforms).toHaveBeenCalledOnce();
    expect(mocks.player.initPlayer).toHaveBeenCalledWith(false, 12);
  });
  it("用户刷新失败仍刷新平台和播放器并报告固定错误", async () => {
    mocks.update.mockRejectedValue(new Error("synthetic sensitive"));
    await expect(completeLogin({ access_token: "accepted" })).rejects.toThrow(
      "Login data refresh failed",
    );
    expect(mocks.platform.loadPlatforms).toHaveBeenCalledOnce();
    expect(mocks.player.initPlayer).toHaveBeenCalledOnce();
    expect(mocks.data.userLoginStatus).toBe(true);
  });
  it("缺失凭据不更改登录状态", async () => {
    await expect(completeLogin({})).rejects.toThrow("Missing login token");
    expect(mocks.data.userLoginStatus).toBe(false);
  });
});
describe("finishWebOAuth", () => {
  it("兑换前清掉state query，刷新不再兑换，成功完成后保留根回跳", async () => {
    let url = "https://example.test/path?state=synthetic&keep=1#hash";
    const deps = {
      url,
      clearQuery: vi.fn((clean: string) => {
        url = `https://example.test${clean}`;
      }),
      exchange: vi.fn<(state: string) => Promise<{ access_token: string }>>(async () => {
        expect(url).not.toContain("state=");
        return { access_token: "synthetic" };
      }),
      accept: vi.fn(async () => {}),
      success: vi.fn(),
      failure: vi.fn(),
      replace: vi.fn(),
    };
    await finishWebOAuth(deps);
    expect(deps.clearQuery).toHaveBeenCalledWith("/path?keep=1#hash");
    expect(deps.accept).toHaveBeenCalledOnce();
    expect(deps.success).toHaveBeenCalledOnce();
    expect(deps.replace).toHaveBeenCalledWith("/");
    await finishWebOAuth({ ...deps, url });
    expect(deps.exchange).toHaveBeenCalledOnce();
  });
  it("兑换错误也清除授权query并回跳，不应用结果", async () => {
    const deps = {
      url: "https://example.test/?state=synthetic",
      clearQuery: vi.fn(),
      exchange: vi.fn().mockRejectedValue(new Error("sensitive")),
      accept: vi.fn(),
      success: vi.fn(),
      failure: vi.fn(),
      replace: vi.fn(),
    };
    await finishWebOAuth(deps);
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.failure).toHaveBeenCalledOnce();
    expect(deps.clearQuery).toHaveBeenCalledWith("/");
    expect(deps.replace).toHaveBeenCalledWith("/");
  });
});
