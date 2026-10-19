import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { useSearchSuggestions } from "./useSearchSuggestions";

function deferred() {
  let resolve!: (value: { keys: string[] }) => void;
  const promise = new Promise<{ keys: string[] }>((done) => (resolve = done));
  return { promise, resolve };
}

describe("useSearchSuggestions", () => {
  const scopes: ReturnType<typeof effectScope>[] = [];

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    scopes.forEach((scope) => scope.stop());
    scopes.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(fetch = vi.fn(async () => ({ keys: ["result"] }))) {
    const keyword = ref("");
    const platform = ref<string | undefined>("platform");
    const scope = effectScope();
    scopes.push(scope);
    const data = scope.run(() => useSearchSuggestions(keyword, platform, fetch))!;
    return { keyword, platform, data, scope, fetch };
  }

  it("快速输入只发送最后一次请求，并去掉关键词两端空白", async () => {
    const { keyword, fetch, data } = setup();
    keyword.value = "a";
    await vi.advanceTimersByTimeAsync(200);
    keyword.value = " ab ";
    await vi.advanceTimersByTimeAsync(299);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("ab", "platform");
    expect(data.value).toEqual(["result"]);
  });

  it("新关键词仍在防抖期间时，旧请求也不能更新结果", async () => {
    const old = deferred();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ keys: ["new"] });
    const { keyword, data } = setup(fetch);
    keyword.value = "a";
    await vi.advanceTimersByTimeAsync(300);
    keyword.value = "ab";
    old.resolve({ keys: ["old"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(data.value).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(data.value).toEqual(["new"]);
  });

  it("清空输入后丢弃旧结果，且不发送空请求", async () => {
    const old = deferred();
    const { keyword, data, fetch } = setup(vi.fn(() => old.promise));
    keyword.value = "a";
    await vi.advanceTimersByTimeAsync(300);
    keyword.value = " ";
    old.resolve({ keys: ["old"] });
    await vi.advanceTimersByTimeAsync(300);
    expect(data.value).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("切换平台后丢弃旧平台结果", async () => {
    const old = deferred();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ keys: ["new"] });
    const { keyword, platform, data } = setup(fetch);
    keyword.value = "a";
    await vi.advanceTimersByTimeAsync(300);
    platform.value = "other";
    await vi.advanceTimersByTimeAsync(300);
    old.resolve({ keys: ["old"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(data.value).toEqual(["new"]);
    expect(fetch).toHaveBeenLastCalledWith("a", "other");
  });

  it("销毁作用域时清理定时器并阻止在途请求更新", async () => {
    const old = deferred();
    const pending = setup(vi.fn(() => old.promise));
    pending.keyword.value = "a";
    await vi.advanceTimersByTimeAsync(300);
    pending.scope.stop();
    old.resolve({ keys: ["old"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.data.value).toEqual([]);

    const delayed = setup();
    delayed.keyword.value = "a";
    delayed.scope.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(delayed.fetch).not.toHaveBeenCalled();
  });

  it("请求失败后可以继续搜索", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ keys: ["new"] });
    const { keyword, data } = setup(fetch);
    keyword.value = "a";
    await vi.advanceTimersByTimeAsync(300);
    expect(data.value).toEqual([]);
    keyword.value = "ab";
    await vi.advanceTimersByTimeAsync(300);
    expect(data.value).toEqual(["new"]);
  });
});
