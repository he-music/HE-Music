import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createServer = () => ({
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    request: vi.fn(),
  });

  return {
    neteaseServer: createServer(),
    hemusicServer: createServer(),
    axiosCreate: vi.fn(),
    clearUserData: vi.fn(),
    openUserLogin: vi.fn(),
    refreshTokenApi: vi.fn(),
    dataStore: {
      userLoginStatus: true,
      token: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 1,
    },
  };
});

vi.mock("axios", () => ({
  default: {
    create: mocks.axiosCreate,
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "isAxiosError" in error,
  },
}));

vi.mock("@/utils/env", () => ({ isDev: false }));
vi.mock("@/stores", () => ({
  useDataStore: () => ({ ...mocks.dataStore, clearUserData: mocks.clearUserData }),
  useSettingStore: () => ({ language: "zh-CN", proxyProtocol: "off" }),
}));
vi.mock("@/utils/auth", () => ({ isLogin: () => true }));
vi.mock("@/utils/modal", () => ({
  openCaptcha: vi.fn(),
  openUserLogin: mocks.openUserLogin,
}));
vi.mock("@/api/auth", () => ({ refreshTokenApi: mocks.refreshTokenApi }));
vi.mock("@/utils/device", () => ({ getDeviceInfo: vi.fn().mockResolvedValue({}) }));

type ResponseErrorHandler = (error: any) => Promise<unknown>;

const createHttpError = (status: number, reason?: string, url = "/v1/page") => ({
  isAxiosError: true,
  message: "Request failed",
  config: { url, headers: { set: vi.fn() } },
  response: { status, statusText: "Unauthorized", data: { reason } },
});

describe("HE Music Token 刷新", () => {
  let handleResponseError: ResponseErrorHandler;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.axiosCreate
      .mockReturnValueOnce(mocks.neteaseServer)
      .mockReturnValueOnce(mocks.hemusicServer);
    mocks.clearUserData.mockResolvedValue(undefined);
    mocks.dataStore.userLoginStatus = true;
    mocks.dataStore.token = "access-token";
    mocks.dataStore.refreshToken = "refresh-token";
    mocks.dataStore.expiresAt = 1;

    await import("@/utils/request");
    handleResponseError = mocks.hemusicServer.interceptors.response.use.mock.calls[0][1];
  });

  it("refresh token 无效时清空登录信息并打开登录弹窗", async () => {
    const requestError = createHttpError(401);
    const refreshError = createHttpError(401, "INVALID_REFRESH_TOKEN", "/v1/auth/token/refresh");
    mocks.refreshTokenApi.mockRejectedValue(refreshError);

    await expect(handleResponseError(requestError)).rejects.toBe(requestError);

    expect(mocks.clearUserData).toHaveBeenCalledOnce();
    expect(mocks.openUserLogin).toHaveBeenCalledOnce();
  });

  it.each([
    [500, undefined],
    [401, "TOKEN_EXPIRED"],
  ])("刷新返回 %s/%s 时保留登录状态", async (status, reason) => {
    const requestError = createHttpError(401);
    mocks.refreshTokenApi.mockRejectedValue(
      createHttpError(status, reason, "/v1/auth/token/refresh"),
    );

    await expect(handleResponseError(requestError)).rejects.toBe(requestError);

    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
  });

  it("刷新接口内层 401 原样抛出，避免重复处理", async () => {
    const refreshError = createHttpError(401, "INVALID_REFRESH_TOKEN", "/v1/auth/token/refresh");

    await expect(handleResponseError(refreshError)).rejects.toBe(refreshError);

    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
  });
});
