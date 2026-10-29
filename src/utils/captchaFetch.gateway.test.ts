import { afterEach, expect, it, vi } from "vitest";
import { gatewayProxyUrl, initializeGateway } from "@/platform/gateway";
import { createCaptchaFetch } from "./captchaFetch";

afterEach(() => vi.unstubAllGlobals());

it("Cap 验证码通过固定 API 路由发送 session 和正文，并保留取消信号", async () => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123/session" });
  await initializeGateway(
    { configure: vi.fn(async () => {}) },
    "https://api.invalid/",
    "/api/netease",
  );
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  const request = createCaptchaFetch("captcha-session", undefined, fetchImpl);
  const controller = new AbortController();
  await request("https://api.invalid/v1/captcha/challenge", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:45123/session/__api/hemusic/v1/captcha/challenge",
    expect.objectContaining({
      body: JSON.stringify({ session_id: "captcha-session" }),
      signal: controller.signal,
    }),
  );
});

it("mygo 更新日志使用无身份的通用网关，Web 保留原请求实例", async () => {
  const request = vi.fn().mockResolvedValue([]);
  vi.doMock("@/utils/request", () => ({ default: request }));
  const { updateLog } = await import("@/api/other");
  vi.stubGlobal("window", {});
  await updateLog();
  expect(request).toHaveBeenCalledOnce();
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123/session" });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]"));
  vi.stubGlobal("fetch", fetchImpl);
  await expect(updateLog()).resolves.toEqual([]);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    gatewayProxyUrl("https://api.github.com/repos/he-music/HE-Music/releases?noCookie=true"),
    { credentials: "omit" },
  );
  expect(request).toHaveBeenCalledOnce();
});
