import { describe, expect, it, vi } from "vitest";
import { createCaptchaFetch } from "./captchaFetch";

const redeemUrl = "https://example.com/v1/captcha/redeem";

const redeemRequest = (token: string) => ({
  method: "POST",
  body: JSON.stringify({ token, solutions: [1] }),
});

describe("createCaptchaFetch", () => {
  it("同一会话同一 token 只 redeem 一次，并为每个调用者返回可读取的响应", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, token: "ok" })));
    const capFetch = createCaptchaFetch("session-1", undefined, fetchMock);

    const [first, second] = await Promise.all([
      capFetch(redeemUrl, redeemRequest("challenge-1")),
      capFetch(redeemUrl, redeemRequest("challenge-1")),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      token: "challenge-1",
      solutions: [1],
      session_id: "session-1",
    });
    expect(await first.json()).toEqual(await second.json());

    const later = await capFetch(redeemUrl, redeemRequest("challenge-1"));
    expect(await later.json()).toEqual({ success: true, token: "ok" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("将后端 int64 字符串有效期转换为 widget 可解析的毫秒数", async () => {
    const expires = Date.now() + 60_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, token: "cap-token", expires: String(expires) }),
        ),
      );
    const capFetch = createCaptchaFetch("session-1", undefined, fetchMock);

    const response = await capFetch(redeemUrl, redeemRequest("challenge-1"));
    const result = await response.json();
    expect(result.expires).toBe(expires);
    expect(new Date(result.expires).getTime()).toBe(expires);
    expect(result.token).toBe("cap-token");
  });

  it("不同 token 或不同会话分别提交，失败的 token 不自动重放", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network lost"));
    const firstSession = createCaptchaFetch("session-1", undefined, fetchMock);
    await expect(firstSession(redeemUrl, redeemRequest("challenge-1"))).rejects.toThrow(
      "network lost",
    );
    await expect(firstSession(redeemUrl, redeemRequest("challenge-1"))).rejects.toThrow(
      "network lost",
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    await expect(firstSession(redeemUrl, redeemRequest("challenge-2"))).rejects.toThrow();
    await expect(
      createCaptchaFetch(
        "session-2",
        undefined,
        fetchMock,
      )(redeemUrl, redeemRequest("challenge-1")),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
