import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, shallowRef } from "vue";
import {
  createRecommendationIdentityReset,
  type RecommendationOwner,
} from "./recommendationIdentityReset";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const scopes: ReturnType<typeof effectScope>[] = [];
function fixture() {
  const owner = shallowRef<RecommendationOwner | undefined>({ accountId: "a", epoch: 1 });
  const gate = deferred();
  const reset = vi.fn<(signal: AbortSignal) => Promise<void>>(() => gate.promise);
  const showSuccess = vi.fn();
  const showUnknownResult = vi.fn();
  const scope = effectScope();
  scopes.push(scope);
  const action = scope.run(() =>
    createRecommendationIdentityReset({
      reset,
      currentOwner: () => owner.value,
      showSuccess,
      showUnknownResult,
    }),
  );
  if (!action) throw new Error("missing action");
  return {
    owner,
    gate,
    reset,
    showSuccess,
    showUnknownResult,
    action,
    scope,
  };
}
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

describe("推荐标识重置", () => {
  it("提交期间 loading 并防止重复，成功后提示当前账号", async () => {
    const f = fixture();
    const captured = f.owner.value;
    const request = f.action.reset(captured);
    expect(f.action.loading.value).toBe(true);
    await f.action.reset(captured);
    expect(f.reset).toHaveBeenCalledOnce();
    f.gate.resolve();
    await request;
    expect(f.showSuccess).toHaveBeenCalledOnce();
    expect(f.showUnknownResult).not.toHaveBeenCalled();
    expect(f.action.loading.value).toBe(false);
  });
  it("确认前切换账号不会使用新账号发送旧确认，未登录也不提交", async () => {
    const f = fixture();
    const captured = f.owner.value;
    f.owner.value = { accountId: "b", epoch: 2 };
    await f.action.reset(captured);
    f.owner.value = undefined;
    await f.action.reset();
    expect(f.reset).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"])("账号切换撤销请求并丢弃迟到的 %s", async (outcome) => {
    const f = fixture();
    const request = f.action.reset();
    const signal = f.reset.mock.calls[0][0];
    f.owner.value = { accountId: "b", epoch: 2 };
    expect(signal.aborted).toBe(true);
    if (outcome === "success") f.gate.resolve();
    else f.gate.reject(new TypeError("disconnected"));
    await request;
    expect(f.showSuccess).not.toHaveBeenCalled();
    expect(f.showUnknownResult).not.toHaveBeenCalled();
  });
  it("网络异常只显示未知结果，不自动重试", async () => {
    const f = fixture();
    const request = f.action.reset();
    f.gate.reject(new TypeError("Network Error"));
    await request;
    expect(f.reset).toHaveBeenCalledOnce();
    expect(f.showUnknownResult).toHaveBeenCalledOnce();
    expect(f.action.loading.value).toBe(false);
  });
  it("同账号重新登录及卸载都撤销旧授权请求", async () => {
    const f = fixture();
    const request = f.action.reset();
    f.owner.value = { accountId: "a", epoch: 2 };
    expect(f.reset.mock.calls[0][0].aborted).toBe(true);
    f.scope.stop();
    f.gate.resolve();
    await request;
    expect(f.showSuccess).not.toHaveBeenCalled();
    await f.action.reset();
    expect(f.reset).toHaveBeenCalledOnce();
  });
});
