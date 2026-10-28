import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HemusicRequestConfig } from "./request";

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
    messageError: vi.fn(),
    refreshTokenApi: vi.fn(),
    openCaptcha: vi.fn(),
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

vi.mock("@/utils/env", () => ({ isDev: false, isElectron: false }));
vi.mock("@/stores", () => ({
  useDataStore: () => ({ ...mocks.dataStore, clearUserData: mocks.clearUserData }),
  useSettingStore: () => ({ language: "zh-CN", proxyProtocol: "off" }),
}));
vi.mock("@/utils/auth", () => ({ isLogin: () => true }));
vi.mock("@/utils/modal", () => ({
  openCaptcha: mocks.openCaptcha,
  openUserLogin: mocks.openUserLogin,
}));
vi.mock("@/api/auth", () => ({ refreshTokenApi: mocks.refreshTokenApi }));
vi.mock("@/utils/device", () => ({ getDeviceInfo: vi.fn().mockResolvedValue({}) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

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
    vi.stubGlobal("window", { $message: { error: mocks.messageError } });
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

  afterEach(() => vi.unstubAllGlobals());

  it("由界面处理曲谱请求错误时不重复显示通用错误消息", async () => {
    const error = {
      ...createHttpError(501, "NotImplemented", "/v1/song/sheet-music"),
      config: { ...createHttpError(501).config, skipErrorMessage: true },
    };
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it("mygo 下载通过真实请求拦截器失败时不提前显示原始响应文本", async () => {
    const privateMessage =
      "https://fixture.invalid/song.mp3?signature=private INTERNAL_CODE /fixture/private.mp3";
    mocks.hemusicServer.request.mockImplementationOnce((config: HemusicRequestConfig) => {
      const error = {
        ...createHttpError(500),
        config,
        response: { status: 500, statusText: "Failure", data: { message: privateMessage } },
      };
      return handleResponseError(error);
    });
    const { songUrl } = await import("@/api/song");
    const { createMygoDownloadResolver } = await import("./mygoFileModals");
    const resolve = createMygoDownloadResolver((id, platform, quality, format) =>
      songUrl(id, platform, quality, format, { skipErrorMessage: true }),
    );
    await expect(
      resolve("320", {
        id: "fixture",
        platform: "fixture",
        name: "fixture song",
        links: [{ name: "320", quality: 320, format: "mp3", size: "1 MiB" }],
      }),
    ).rejects.toThrow("Download source unavailable");
    expect(mocks.messageError).not.toHaveBeenCalled();
    expect(mocks.hemusicServer.request).toHaveBeenCalledWith(
      expect.objectContaining({ skipErrorMessage: true }),
    );
  });

  it("歌曲URL旧四参调用继续沿用默认请求提示行为", async () => {
    mocks.hemusicServer.request.mockResolvedValueOnce({
      url: "https://fixture.invalid/song.mp3",
      format: "mp3",
    });
    const { songUrl } = await import("@/api/song");
    await songUrl("fixture", "fixture", 320, "mp3");
    expect(mocks.hemusicServer.request).toHaveBeenCalledWith({
      url: "/v1/song/url",
      params: { id: "fixture", platform: "fixture", quality: 320, format: "mp3" },
    });
  });

  it("普通请求继续显示通用错误消息", async () => {
    const error = createHttpError(500, "INTERNAL_ERROR");
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.messageError).toHaveBeenCalledWith("Request failed");
  });

  it("曲谱请求即使关闭通用提示，401 仍走登录处理", async () => {
    mocks.dataStore.refreshToken = "";
    const error = {
      ...createHttpError(401),
      config: { ...createHttpError(401).config, skipErrorMessage: true },
    };
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.openUserLogin).toHaveBeenCalledOnce();
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

  it("并发 401 只刷新一次，并分别携带新令牌重试原请求", async () => {
    const first = createHttpError(401, undefined, "/v1/page/one");
    const second = createHttpError(401, undefined, "/v1/page/two");
    const firstResponse = { data: { id: "one" } };
    const secondResponse = { data: { id: "two" } };
    let resolveRefresh!: (result: {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    }) => void;
    mocks.refreshTokenApi.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    mocks.hemusicServer.request.mockImplementation(async (config) =>
      config === first.config ? firstResponse : secondResponse,
    );
    const firstRun = handleResponseError(first);
    const secondRun = handleResponseError(second);
    await vi.waitFor(() => expect(mocks.refreshTokenApi).toHaveBeenCalledOnce());
    resolveRefresh({
      access_token: "renewed-access",
      refresh_token: "renewed-refresh",
      expires_at: 2_000_000_000,
    });
    expect(await Promise.all([firstRun, secondRun])).toEqual([firstResponse, secondResponse]);
    expect(mocks.refreshTokenApi).toHaveBeenCalledOnce();
    expect(mocks.hemusicServer.request).toHaveBeenCalledTimes(2);
    expect(mocks.hemusicServer.request).toHaveBeenCalledWith(first.config);
    expect(mocks.hemusicServer.request).toHaveBeenCalledWith(second.config);
    for (const error of [first, second]) {
      expect(error.config.headers.set).toHaveBeenCalledExactlyOnceWith(
        "Authorization",
        "Bearer renewed-access",
      );
    }
    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
    expect(mocks.openCaptcha).not.toHaveBeenCalled();
  });

  it("密码验证码重试保留登录字段，只取得一次票据且不重复请求", async () => {
    const base = createHttpError(403, "CAPTCHA_REQUIRED", "/v1/user/login");
    const credentials = { username: "synthetic-user", password: "synthetic-password" };
    const error = {
      ...base,
      config: { ...base.config, data: JSON.stringify(credentials) },
      response: {
        ...base.response,
        data: {
          reason: "CAPTCHA_REQUIRED",
          metadata: { scene: "1", meta: "synthetic-captcha-meta" },
        },
      },
    };
    const response = { data: { access_token: "synthetic-access" } };
    mocks.openCaptcha.mockResolvedValueOnce("synthetic-ticket");
    mocks.hemusicServer.request.mockResolvedValueOnce(response);
    expect(await handleResponseError(error)).toBe(response);
    expect(mocks.openCaptcha).toHaveBeenCalledExactlyOnceWith(1, "synthetic-captcha-meta");
    expect(mocks.hemusicServer.request).toHaveBeenCalledExactlyOnceWith(error.config);
    expect(error.config.data).toEqual({ ...credentials, captcha_ticket: "synthetic-ticket" });
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.openCaptcha).toHaveBeenCalledOnce();
    expect(mocks.hemusicServer.request).toHaveBeenCalledOnce();
  });
});
