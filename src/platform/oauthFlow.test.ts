import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthFlow, type OAuthDependencies } from "./oauthFlow";
import type { GetAuthStatusResponse } from "@/api/auth";

const result = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: 1_900_000_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const statusReply = (status: GetAuthStatusResponse["status"] = "pending") => ({
  status,
  error: "",
  check_interval: 2,
  expires_at: Date.now() / 1000 + 120,
});
function setup() {
  const order: string[] = [];
  let sequence = 0;
  const deps = {
    create: vi.fn<OAuthDependencies["create"]>(async (provider) => {
      order.push("create");
      return {
        url: `https://example.test/${provider}`,
        state: `state-${++sequence}`,
        expires_at: Date.now() / 1000 + 120,
        check_interval: 2,
      };
    }),
    status: vi.fn<OAuthDependencies["status"]>(async () => {
      order.push("status");
      return statusReply();
    }),
    exchange: vi.fn<OAuthDependencies["exchange"]>(async () => {
      order.push("exchange");
      return result;
    }),
    open: vi.fn<OAuthDependencies["open"]>(async () => {
      order.push("open");
    }),
    accept: vi.fn<OAuthDependencies["accept"]>(async () => {}),
    onError: vi.fn(),
    onPendingChange: vi.fn(),
  };
  return { deps, order, flow: createOAuthFlow(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("OAuth status polling flow", () => {
  it("创建会话并打开浏览器，pending 只查询状态，success 才领取一次结果", async () => {
    const s = setup();
    s.deps.status
      .mockResolvedValueOnce(statusReply())
      .mockResolvedValueOnce(statusReply("success"));
    await s.flow.start("dynamic-provider");
    expect(s.order).toEqual(["create", "open"]);
    expect(s.deps.onPendingChange.mock.calls).toEqual([[true]]);
    expect(s.deps.create).toHaveBeenCalledWith("dynamic-provider", expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.status).toHaveBeenCalledExactlyOnceWith("state-1", expect.any(AbortSignal));
    expect(s.deps.exchange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.exchange).toHaveBeenCalledExactlyOnceWith("state-1", expect.any(AbortSignal));
    expect(s.deps.accept).toHaveBeenCalledExactlyOnceWith(result);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.deps.status).toHaveBeenCalledTimes(2);
    expect(s.deps.exchange).toHaveBeenCalledOnce();
    expect(s.deps.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.deps.onPendingChange.mock.calls).toEqual([[true], [false]]);
  });
  it("按后端 protobuf JSON 字符串期限完成授权", async () => {
    const s = setup();
    const expires_at = String(Date.now() / 1000 + 120);
    s.deps.create.mockResolvedValueOnce({
      url: "https://example.test",
      state: "wire-state",
      expires_at,
      check_interval: 2,
    });
    s.deps.status.mockResolvedValueOnce({ ...statusReply("success"), expires_at });
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.exchange).toHaveBeenCalledExactlyOnceWith("wire-state", expect.any(AbortSignal));
    expect(s.deps.accept).toHaveBeenCalledExactlyOnceWith(result);
  });
  it.each([0, -1, NaN, Infinity, "invalid", "", Date.UTC(2020, 0, 1) / 1000])(
    "无效或已过期的 Unix 秒期限 %s 不打开授权页",
    async (expires_at) => {
      const s = setup();
      s.deps.create.mockResolvedValueOnce({
        url: "https://example.test",
        state: "invalid-expiry",
        expires_at,
        check_interval: 2,
      });
      await s.flow.start("one");
      expect(s.deps.open).not.toHaveBeenCalled();
      expect(s.deps.onError).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(s.deps.onPendingChange.mock.calls).toEqual([[true], [false]]);
    },
  );

  it("按服务端更新后的 check_interval 轮询，状态请求未完成时不重叠发送", async () => {
    const s = setup();
    const pending = deferred<GetAuthStatusResponse>();
    s.deps.status.mockReturnValueOnce(pending.promise);
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(7000);
    expect(s.deps.status).toHaveBeenCalledOnce();
    pending.resolve({ ...statusReply(), check_interval: 5 });
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.deps.status).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.deps.status).toHaveBeenCalledTimes(2);
    s.flow.cancel();
  });

  it.each([0, -1, NaN, Infinity])("无效轮询间隔 %s 使用默认间隔", async (interval) => {
    const s = setup();
    s.deps.create.mockResolvedValueOnce({
      url: "https://example.test",
      state: "state-1",
      expires_at: Date.now() / 1000 + 120,
      check_interval: interval,
    });
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.deps.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.deps.status).toHaveBeenCalledOnce();
  });

  it.each(["failed", "expired"] as const)("%s 终止轮询且不领取结果", async (status) => {
    const s = setup();
    s.deps.status.mockResolvedValueOnce({ ...statusReply(status), expires_at: 0 });
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.deps.onError).toHaveBeenCalledOnce();
    expect(s.deps.status).toHaveBeenCalledOnce();
    expect(s.deps.exchange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["create", "status", "exchange"] as const)(
    "取消 %s 时中止请求并丢弃迟到响应",
    async (stage) => {
      const s = setup();
      s.deps.status.mockResolvedValue(statusReply("success"));
      const creation = deferred<Awaited<ReturnType<OAuthDependencies["create"]>>>();
      const status = deferred<GetAuthStatusResponse>();
      const exchange = deferred<typeof result>();
      if (stage === "create") s.deps.create.mockReturnValueOnce(creation.promise);
      if (stage === "status") s.deps.status.mockReturnValueOnce(status.promise);
      if (stage === "exchange") s.deps.exchange.mockReturnValueOnce(exchange.promise);
      const start = s.flow.start("one");
      await flush();
      if (stage !== "create") await vi.advanceTimersByTimeAsync(2000);
      const signal = s.deps.create.mock.calls[0][1];
      s.flow.cancel();
      expect(signal.aborted).toBe(true);
      creation.resolve({
        url: "https://old.test",
        state: "old",
        expires_at: Date.now() / 1000 + 60,
        check_interval: 2,
      });
      status.resolve(statusReply("success"));
      exchange.resolve(result);
      await start;
      await flush();
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.deps.accept).not.toHaveBeenCalled();
      expect(s.deps.onError).not.toHaveBeenCalled();
      expect(s.deps.onPendingChange.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
      if (stage === "create") expect(s.deps.open).not.toHaveBeenCalled();
      if (stage === "status") expect(s.deps.exchange).not.toHaveBeenCalled();
    },
  );

  it("替换后旧 status 的 success 不能兑换，新会话使用自己的 state", async () => {
    const s = setup();
    const old = deferred<GetAuthStatusResponse>();
    s.deps.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(statusReply("success"));
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(2000);
    await s.flow.start("two");
    old.resolve(statusReply("success"));
    await flush();
    expect(s.deps.exchange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.exchange).toHaveBeenCalledExactlyOnceWith("state-2", expect.any(AbortSignal));
  });

  it("替换后迟到的 create 不打开浏览器、不开始轮询", async () => {
    const s = setup();
    const old = deferred<Awaited<ReturnType<OAuthDependencies["create"]>>>();
    s.deps.create.mockReturnValueOnce(old.promise);
    const first = s.flow.start("one");
    await s.flow.start("two");
    old.resolve({
      url: "https://old.test",
      state: "old",
      expires_at: Date.now() / 1000 + 60,
      check_interval: 2,
    });
    await first;
    expect(s.deps.open).toHaveBeenCalledExactlyOnceWith("https://example.test/two");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.status).toHaveBeenCalledExactlyOnceWith("state-1", expect.any(AbortSignal));
  });

  it.each(["create", "open", "status", "exchange", "accept"] as const)(
    "%s 失败只报告一次并停止轮询",
    async (stage) => {
      const s = setup();
      s.deps.status.mockResolvedValue(statusReply("success"));
      s.deps[stage].mockRejectedValueOnce(new Error("sensitive response"));
      await s.flow.start("one");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.deps.onError).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("本地期限覆盖未完成的状态请求，迟到 success 不领取结果", async () => {
    const s = setup();
    const status = deferred<GetAuthStatusResponse>();
    s.deps.status.mockReturnValueOnce(status.promise);
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.deps.onError).toHaveBeenCalledOnce();
    status.resolve(statusReply("success"));
    await flush();
    expect(s.deps.exchange).not.toHaveBeenCalled();
    expect(s.deps.create.mock.calls[0][1].aborted).toBe(true);
  });

  it("创建超时后不打开迟到会话", async () => {
    const s = setup();
    const pending = deferred<Awaited<ReturnType<OAuthDependencies["create"]>>>();
    s.deps.create.mockReturnValueOnce(pending.promise);
    const start = s.flow.start("one");
    await vi.advanceTimersByTimeAsync(60_000);
    pending.resolve({
      url: "https://late.test",
      state: "late",
      expires_at: Date.now() / 1000 + 60,
      check_interval: 2,
    });
    await start;
    expect(s.deps.onError).toHaveBeenCalledOnce();
    expect(s.deps.open).not.toHaveBeenCalled();
  });

  it("服务端缩短过期时间后按新期限终止", async () => {
    const s = setup();
    s.deps.status.mockResolvedValueOnce({ ...statusReply(), expires_at: Date.now() / 1000 + 3 });
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.deps.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.deps.onError).toHaveBeenCalledOnce();
    expect(s.deps.exchange).not.toHaveBeenCalled();
  });

  it("接受结果导致卸载时不撤回已领取结果", async () => {
    const s = setup();
    s.deps.status.mockResolvedValueOnce(statusReply("success"));
    s.deps.accept.mockImplementation(async () => s.flow.cancel());
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.deps.accept).toHaveBeenCalledExactlyOnceWith(result);
    expect(s.deps.onError).not.toHaveBeenCalled();
  });
});
