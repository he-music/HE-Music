import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authExpiryUnixMs, createOAuthFlow, type AuthCallbackEvent } from "./oauthFlow";
import type { OAuthDependencies } from "./oauthFlow";

const result = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_at: 1_900_000_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function setup() {
  const listeners: Array<(event: AuthCallbackEvent) => void> = [];
  const order: string[] = [];
  let sequence = 0;
  const deps = {
    subscribe: vi.fn((listener: (event: AuthCallbackEvent) => void) => {
      order.push("subscribe");
      listeners.push(listener);
      return vi.fn();
    }),
    prepare: vi.fn(async () => {
      order.push("prepare");
      return {
        sessionId: `session-${++sequence}`,
        callbackUrl: "http://127.0.0.1:25666/login/success",
      };
    }),
    arm: vi.fn(async () => {
      order.push("arm");
    }),
    cancel: vi.fn<OAuthDependencies["cancel"]>(async () => {}),
    create: vi.fn<OAuthDependencies["create"]>(async (provider) => {
      order.push("create");
      return {
        url: `https://example.test/${provider}`,
        state: `state-${sequence}`,
        expires_at: Date.now() / 1000 + 120,
        check_interval: 2,
      };
    }),
    exchange: vi.fn<OAuthDependencies["exchange"]>(async () => result),
    open: vi.fn<OAuthDependencies["open"]>(async () => {
      order.push("open");
    }),
    accept: vi.fn<OAuthDependencies["accept"]>(async () => {}),
    onError: vi.fn(),
  };
  const flow = createOAuthFlow(deps);
  return {
    deps,
    flow,
    order,
    listeners,
    emit: (sessionId = "session-1", state = "state-1") => listeners.at(-1)?.({ sessionId, state }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("OAuth callback flow", () => {
  it("订阅/预留/后端创建/arm/外链严格有序，动态 provider 不受限，重复事件只兑换一次", async () => {
    const s = setup();
    await s.flow.start("dynamic-provider");
    expect(s.order).toEqual(["subscribe", "prepare", "create", "arm", "open"]);
    expect(s.deps.create).toHaveBeenCalledWith(
      "dynamic-provider",
      "http://127.0.0.1:25666/login/success",
    );
    expect(s.deps.arm).toHaveBeenCalledWith("session-1", "state-1", Date.now() + 120_000);
    s.emit("old-session");
    s.emit("session-1", "wrong-state");
    expect(s.deps.exchange).not.toHaveBeenCalled();
    s.emit();
    s.emit();
    await flush();
    expect(s.deps.exchange).toHaveBeenCalledOnce();
    expect(s.deps.accept).toHaveBeenCalledWith(result);
    expect(s.deps.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
    expect(s.deps.cancel).toHaveBeenCalledWith("session-1");
  });
  it("替换后旧监听/事件无效，只兑换新会话", async () => {
    const s = setup();
    await s.flow.start("one");
    await s.flow.start("two");
    s.listeners[0]({ sessionId: "session-1", state: "state-1" });
    s.emit("session-2", "state-1");
    expect(s.deps.exchange).not.toHaveBeenCalled();
    s.emit("session-2", "state-2");
    await flush();
    expect(s.deps.exchange).toHaveBeenCalledExactlyOnceWith("state-2");
  });
  it.each(["close", "unmount", "pause"])("%s 调用cancel立即失效，兑换迟到不应用", async () => {
    const s = setup();
    const pending = deferred<typeof result>();
    s.deps.exchange.mockReturnValueOnce(pending.promise);
    await s.flow.start("one");
    s.emit();
    s.flow.cancel();
    pending.resolve(result);
    await flush();
    s.emit();
    expect(s.deps.accept).not.toHaveBeenCalled();
    expect(s.deps.exchange).toHaveBeenCalledOnce();
    expect(s.deps.onError).not.toHaveBeenCalled();
  });
  it("prepare迟到后先精确清理才允许下次prepare，不替换新Go监听", async () => {
    const s = setup();
    const pending = deferred<{ sessionId: string; callbackUrl: string }>();
    s.deps.prepare.mockReturnValueOnce(pending.promise);
    const first = s.flow.start("one");
    await flush();
    const second = s.flow.start("two");
    await flush();
    expect(s.deps.prepare).toHaveBeenCalledOnce();
    pending.resolve({ sessionId: "late", callbackUrl: "http://127.0.0.1:25666/login/success" });
    await Promise.all([first, second]);
    expect(s.deps.cancel).toHaveBeenCalledWith("late");
    expect(s.deps.create).toHaveBeenCalledOnce();
    expect(s.deps.create.mock.calls[0][0]).toBe("two");
  });
  it("关闭后迟到prepare只清理，不请求后端/开浏览器", async () => {
    const s = setup();
    const pending = deferred<{ sessionId: string; callbackUrl: string }>();
    s.deps.prepare.mockReturnValueOnce(pending.promise);
    const run = s.flow.start("one");
    await flush();
    s.flow.cancel();
    pending.resolve({ sessionId: "late", callbackUrl: "unused" });
    await run;
    expect(s.deps.cancel).toHaveBeenCalledWith("late");
    expect(s.deps.create).not.toHaveBeenCalled();
    expect(s.deps.open).not.toHaveBeenCalled();
  });
  it("后端创建迟到不会arm/打开/覆盖替换结果", async () => {
    const s = setup();
    const pending = deferred<Awaited<ReturnType<typeof s.deps.create>>>();
    s.deps.create.mockReturnValueOnce(pending.promise);
    const first = s.flow.start("one");
    await flush();
    await s.flow.start("two");
    pending.resolve({
      url: "https://old.test",
      state: "old-state",
      expires_at: Date.now() + 60_000,
      check_interval: 2,
    });
    await first;
    expect(s.deps.arm).toHaveBeenCalledOnce();
    expect(s.deps.open).toHaveBeenCalledExactlyOnceWith("https://example.test/two");
  });
  it("arm迟到或失败不能打开浏览器", async () => {
    const s = setup();
    const pending = deferred<void>();
    s.deps.arm.mockReturnValueOnce(pending.promise);
    const run = s.flow.start("one");
    await flush();
    s.emit();
    s.flow.cancel();
    pending.resolve();
    await run;
    expect(s.deps.exchange).not.toHaveBeenCalled();
    expect(s.deps.open).not.toHaveBeenCalled();
  });
  it.each(["prepare", "create", "arm", "open", "exchange", "accept"] as const)(
    "%s失败显示当前错误且清理监听，不输出敏感对象",
    async (stage) => {
      const s = setup();
      s.deps[stage].mockRejectedValueOnce(new Error("sensitive response"));
      await s.flow.start("one");
      if (stage === "exchange" || stage === "accept") {
        s.emit();
        await flush();
      }
      expect(s.deps.onError).toHaveBeenCalledOnce();
      expect(s.deps.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
    },
  );
  it("过期/准备超时都清理且拒绝随后事件", async () => {
    const s = setup();
    await s.flow.start("one");
    await vi.advanceTimersByTimeAsync(120_000);
    s.emit();
    expect(s.deps.onError).toHaveBeenCalledOnce();
    expect(s.deps.exchange).not.toHaveBeenCalled();
    const late = deferred<{ sessionId: string; callbackUrl: string }>();
    s.deps.prepare.mockReturnValueOnce(late.promise);
    const run = s.flow.start("two");
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    late.resolve({ sessionId: "late", callbackUrl: "unused" });
    await run;
    expect(s.deps.onError).toHaveBeenCalledTimes(2);
    expect(s.deps.cancel).toHaveBeenCalledWith("late");
  });
  it("接受后触发卸载不撤销已接受结果；Go已消费cancel拒绝可清理", async () => {
    const s = setup();
    s.deps.cancel.mockRejectedValue(new Error("already consumed"));
    s.deps.accept.mockImplementation(async () => {
      s.flow.cancel();
    });
    await s.flow.start("one");
    s.emit();
    await flush();
    expect(s.deps.accept).toHaveBeenCalledOnce();
    expect(s.deps.onError).not.toHaveBeenCalled();
  });
});

describe("authExpiryUnixMs", () => {
  it("绝对秒/毫秒转换等值", () => {
    expect(authExpiryUnixMs(Date.now() / 1000 + 60)).toBe(Date.now() + 60_000);
    expect(authExpiryUnixMs(Date.now() + 60_000)).toBe(Date.now() + 60_000);
  });
  it.each([NaN, Infinity, -1, 60, 1.5, Number.MAX_SAFE_INTEGER, Date.UTC(2100, 0, 1)])(
    "拒绝未知/相对/越界值 %s",
    (value) => {
      expect(() => authExpiryUnixMs(value)).toThrow();
    },
  );
  it("拒绝过去或刚好到期", () => {
    expect(() => authExpiryUnixMs(Date.now())).toThrow();
    expect(() => authExpiryUnixMs(Date.now() / 1000 - 1)).toThrow();
  });
});
