import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosHeaders } from "axios";
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

vi.mock("axios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("axios")>()),
  default: {
    create: mocks.axiosCreate,
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "isAxiosError" in error,
  },
}));

vi.mock("@/utils/env", () => ({ isDev: false }));
vi.mock("@/stores", () => ({
  useDataStore: () => Object.assign(mocks.dataStore, { clearUserData: mocks.clearUserData }),
  useSettingStore: () => ({ language: "zh-CN", proxyProtocol: "off" }),
}));
vi.mock("@/utils/auth", () => ({ isLogin: () => mocks.dataStore.userLoginStatus }));
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
    vi.stubEnv("VITE_API_URL", "https://api.fixture.invalid");
    vi.stubEnv("VITE_NETEASE_API_URL", "/api/netease");
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("匿名401不刷新、不弹窗、不匿名重放", async () => {
    Object.assign(mocks.dataStore, { token: "", refreshToken: "", userLoginStatus: false });
    const error = createHttpError(401);
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
    expect(mocks.hemusicServer.request).not.toHaveBeenCalled();
  });

  it("旧匿名401在登录后返回时不影响新身份", async () => {
    const error = {
      ...createHttpError(401),
      config: { url: "/v1/platforms", headers: new AxiosHeaders() },
    };
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
  });

  it("登录标记失效但仍有凭据时不能降级匿名", () => {
    mocks.dataStore.userLoginStatus = false;
    const intercept = mocks.hemusicServer.interceptors.request.use.mock.calls[0][0];
    const config = intercept({ headers: new AxiosHeaders(), url: "/v1/platforms" });
    expect(config.headers.get("Authorization")).toBe("Bearer access-token");
    const netease = mocks.neteaseServer.interceptors.request.use.mock.calls[0][0];
    const thirdParty = netease({
      headers: new AxiosHeaders({ "X-Client-Instance-ID": "private" }),
      url: "/song",
    });
    expect(thirdParty.headers.has("X-Client-Instance-ID")).toBe(false);
  });
  it("刷新后的401不再刷新，也不降级匿名重放", async () => {
    const error = createHttpError(401);
    mocks.refreshTokenApi.mockResolvedValueOnce({
      access_token: "renewed",
      refresh_token: "refresh2",
      expires_at: 2,
    });
    mocks.hemusicServer.request.mockImplementationOnce((config) =>
      handleResponseError({ ...error, config }),
    );
    await expect(handleResponseError(error)).rejects.toBeDefined();
    expect(mocks.refreshTokenApi).toHaveBeenCalledOnce();
    expect(mocks.hemusicServer.request).toHaveBeenCalledOnce();
    expect(mocks.clearUserData).toHaveBeenCalledOnce();
  });

  it("刷新期间退出后不恢复旧凭据", async () => {
    let finish!: (value: unknown) => void;
    mocks.refreshTokenApi.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const error = createHttpError(401);
    const run = handleResponseError(error);
    await vi.waitFor(() => expect(mocks.refreshTokenApi).toHaveBeenCalledOnce());
    Object.assign(mocks.dataStore, { token: "", refreshToken: "", userLoginStatus: false });
    finish({ access_token: "stale", refresh_token: "stale", expires_at: 2 });
    await expect(run).rejects.toBe(error);
    expect(mocks.dataStore.token).toBe("");
    expect(mocks.hemusicServer.request).not.toHaveBeenCalled();
  });

  it("实例Header仅进入本站API，外部请求主动删除且Web禁止自动redirect", () => {
    const intercept = mocks.hemusicServer.interceptors.request.use.mock.calls[0][0];
    const local = intercept({ headers: new AxiosHeaders(), url: "/v1/platforms" });
    expect(local.headers.get("X-Client-Instance-ID")).toMatch(/^[!-~]{1,128}$/);
    const external = intercept({
      headers: new AxiosHeaders({ "X-Client-Instance-ID": "must-remove" }),
      url: "https://cdn.invalid/song",
    });
    expect(external.headers.has("X-Client-Instance-ID")).toBe(false);
    expect(mocks.axiosCreate.mock.calls[1][0]).toMatchObject({
      adapter: "fetch",
      fetchOptions: { redirect: "error" },
    });
  });
  it("由界面处理曲谱请求错误时不重复显示通用错误消息", async () => {
    const error = {
      ...createHttpError(501, "NotImplemented", "/v1/song/sheet-music"),
      config: { ...createHttpError(501).config, skipErrorMessage: true },
    };
    await expect(handleResponseError(error)).rejects.toBe(error);
    expect(mocks.messageError).not.toHaveBeenCalled();
  });
  it("推荐标识重置复用当前鉴权且只发送一次空请求体", async () => {
    const intercept = mocks.hemusicServer.interceptors.request.use.mock.calls[0][0];
    const config = intercept({
      headers: new AxiosHeaders(),
      url: "/v1/user/provider-identity/reset",
    });
    expect(config.headers.get("Authorization")).toBe("Bearer access-token");
    mocks.hemusicServer.request.mockResolvedValueOnce({ data: {} });
    const { resetProviderIdentity } = await import("@/api/providerIdentity");
    await expect(resetProviderIdentity()).resolves.toBeUndefined();
    expect(mocks.hemusicServer.request).toHaveBeenCalledExactlyOnceWith({
      url: "/v1/user/provider-identity/reset",
      method: "post",
      data: {},
      signal: undefined,
      skipAuthRefresh: true,
      skipErrorMessage: true,
    });
  });

  it.each([401, undefined])("推荐重置遇到 %s 不刷新重放、不清登录也不重复提示", async (status) => {
    mocks.hemusicServer.request.mockImplementationOnce((config: HemusicRequestConfig) => {
      const original = createHttpError(status ?? 0);
      return handleResponseError({
        ...original,
        config,
        response: status ? original.response : undefined,
      });
    });
    const { resetProviderIdentity } = await import("@/api/providerIdentity");
    await expect(resetProviderIdentity()).rejects.toBeDefined();
    expect(mocks.hemusicServer.request).toHaveBeenCalledOnce();
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
    expect(mocks.clearUserData).not.toHaveBeenCalled();
    expect(mocks.openUserLogin).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
    expect(mocks.dataStore.userLoginStatus).toBe(true);
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

  it("mygo 的请求改写保留原地址，刷新后复用路由并更新令牌", async () => {
    vi.stubGlobal("window", {
      __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123/session",
      $message: { error: mocks.messageError },
    });
    const gateway = await import("@/platform/gateway");
    const { API_URL } = await import("./request");
    await gateway.initializeGateway({ configure: vi.fn(async () => {}) }, API_URL, "/api/netease");
    const headers = new AxiosHeaders({ Authorization: "Bearer access-token" });
    const setHeader = vi.spyOn(headers, "set");
    const error = {
      ...createHttpError(401),
      config: { url: "/v1/page?keep=%2B", headers },
    };
    const config = gateway.rewriteRequestToGateway(error.config, API_URL);
    expect(config.url).toContain("/session/__api/hemusic/v1/page?keep=%2B");
    mocks.refreshTokenApi.mockResolvedValueOnce({
      access_token: "renewed-access",
      refresh_token: "renewed-refresh",
      expires_at: 1000,
    });
    const response = { data: { ok: true } };
    mocks.hemusicServer.request.mockImplementationOnce(async (retry) => {
      expect(gateway.rewriteRequestToGateway(retry, API_URL).url).toBe(config.url);
      return response;
    });
    await expect(handleResponseError(error)).resolves.toBe(response);
    expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer renewed-access");
    expect(gateway.gatewayRequestURL(config)).toBe("/v1/page?keep=%2B");
  });

  it("mygo 验证码重试仍能识别登录路径且保留请求体", async () => {
    vi.stubGlobal("window", {
      __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123/session",
      $message: { error: mocks.messageError },
    });
    const gateway = await import("@/platform/gateway");
    const { API_URL } = await import("./request");
    await gateway.initializeGateway({ configure: vi.fn(async () => {}) }, API_URL, "/api/netease");
    const config = gateway.rewriteRequestToGateway(
      {
        url: "/v1/user/login",
        data: JSON.stringify({ username: "fixture" }),
      },
      API_URL,
    );
    mocks.openCaptcha.mockResolvedValueOnce("ticket");
    const response = { data: { ok: true } };
    mocks.hemusicServer.request.mockResolvedValueOnce(response);
    await expect(
      handleResponseError({
        config,
        response: {
          status: 403,
          data: { reason: "CAPTCHA_REQUIRED", metadata: { scene: "1", meta: "fixture" } },
        },
      }),
    ).resolves.toBe(response);
    expect(mocks.hemusicServer.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: config.url,
        data: { username: "fixture", captcha_ticket: "ticket" },
      }),
    );
    expect(mocks.openCaptcha).toHaveBeenCalledOnce();
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
