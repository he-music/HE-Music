import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQrLoginFlow } from "./qrLogin";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const session = {
  session_id: "qr-one",
  result_token: "synthetic",
  qr_content: "synthetic-qr",
  status: "pending",
  check_interval: 2,
  expires_at: 1_900_000_000,
};
const status = {
  session_id: "qr-one",
  status: "confirmed",
  check_interval: 2,
  expires_at: 1_900_000_000,
  client_name: "test",
  user_hint: "",
};
const result = {
  session_id: "qr-one",
  status: "success",
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_at: 1_900_000_000,
};
function setup() {
  const deps = {
    create: vi.fn(async () => session),
    status: vi.fn<(id: string) => Promise<typeof status>>(async () => status),
    exchange: vi.fn<(id: string, token: string) => Promise<typeof result>>(async () => result),
    update: vi.fn(),
    accept: vi.fn(),
    onError: vi.fn(),
  };
  return { deps, flow: createQrLoginFlow(deps) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("QR login flow", () => {
  it("轮询后兑换一次并清除计时器", async () => {
    const { deps, flow } = setup();
    await flow.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.status).toHaveBeenCalledExactlyOnceWith("qr-one");
    expect(deps.exchange).toHaveBeenCalledExactlyOnceWith("qr-one", "synthetic");
    expect(deps.accept).toHaveBeenCalledExactlyOnceWith(result);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.exchange).toHaveBeenCalledOnce();
  });
  it("pause/unmount后迟到create不更新也不轮询，恢复创建新会话", async () => {
    const { deps, flow } = setup();
    const pending = deferred<typeof session>();
    deps.create.mockReturnValueOnce(pending.promise);
    const run = flow.start();
    flow.stop();
    pending.resolve(session);
    await run;
    expect(deps.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.status).not.toHaveBeenCalled();
    await flow.start();
    expect(deps.create).toHaveBeenCalledTimes(2);
  });
  it("轮询迟到不能在stop后触发兑换/刷新", async () => {
    const { deps, flow } = setup();
    const pending = deferred<typeof status>();
    deps.status.mockReturnValueOnce(pending.promise);
    await flow.start();
    await vi.advanceTimersByTimeAsync(2000);
    flow.stop();
    pending.resolve(status);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.exchange).not.toHaveBeenCalled();
  });
  it("兑换迟到不能在stop或替换后应用登录", async () => {
    const { deps, flow } = setup();
    const pending = deferred<typeof result>();
    deps.exchange.mockReturnValueOnce(pending.promise);
    await flow.start();
    await vi.advanceTimersByTimeAsync(2000);
    flow.stop();
    await flow.start();
    pending.resolve(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.update.mock.calls.at(-1)?.[0].status).toBe("pending");
  });
  it("后端过期时重建会话，失败仅提示固定错误key", async () => {
    const { deps, flow } = setup();
    deps.status.mockResolvedValueOnce({ ...status, status: "expired" });
    await flow.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.create).toHaveBeenCalledTimes(2);
    deps.status.mockRejectedValueOnce(new Error("sensitive"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.onError).toHaveBeenCalledExactlyOnceWith("modal.qr_login_status_failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
