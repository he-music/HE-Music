import { afterEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/utils/request", () => ({ requestHemusic: request }));
import { createAuthSession, exchangeAuthResult, getAuthStatus } from "./auth";

afterEach(() => vi.clearAllMocks());

describe("OAuth API contract", () => {
  it("轮询会话的请求体没有 redirect_uri，Web 仍可指定回跳地址", async () => {
    await createAuthSession({ provider: "provider" });
    expect(request.mock.calls[0][0].data).toEqual({ provider: "provider" });
    expect(request.mock.calls[0][0].data).not.toHaveProperty("redirect_uri");
    await createAuthSession({ provider: "provider", redirect_uri: "https://client.example" });
    expect(request.mock.calls[1][0].data.redirect_uri).toBe("https://client.example");
  });

  it("状态查询和一次性结果领取使用各自端点，并传递取消信号", async () => {
    const { signal } = new AbortController();
    await getAuthStatus("synthetic-state", signal);
    await exchangeAuthResult("synthetic-state", signal);
    expect(request).toHaveBeenNthCalledWith(1, {
      url: "/v1/auth/status",
      method: "get",
      params: { state: "synthetic-state" },
      signal,
      skipErrorMessage: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      url: "/v1/auth/result",
      method: "get",
      params: { state: "synthetic-state" },
      signal,
      skipErrorMessage: true,
    });
  });
});
