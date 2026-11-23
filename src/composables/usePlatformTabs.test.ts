import { effectScope, nextTick, reactive, type EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabInfo } from "@/types/main.hemusic";
import { usePlatformTabs, type ReleaseRouteName } from "./usePlatformTabs";

const requiredFlags = 3n;
const platform = (id: string, feature_support_flag = requiredFlags, status = 1) => ({
  id,
  feature_support_flag,
  status,
});
const route = reactive({ name: "", query: {} as Record<string, string> });
const store = reactive({ platforms: [] as ReturnType<typeof platform>[], loading: true });
const replace = vi.fn((target: typeof route) => Object.assign(route, target));
vi.mock("vue-router", () => ({ useRoute: () => route, useRouter: () => ({ replace }) }));
vi.mock("@/stores/platform", () => ({ usePlatformStore: () => store }));

const scopes: EffectScope[] = [];
function setup(
  name: ReleaseRouteName,
  fetchTabs: (platform: string) => Promise<{ list: TabInfo[] }>,
) {
  route.name = name;
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => usePlatformTabs(name, requiredFlags, fetchTabs))!;
}
const tab = (id: string, platform = "qq"): TabInfo => ({ id, platform, name: id });
const flush = async () => {
  await nextTick();
  await Promise.resolve();
  await nextTick();
};

function deferredTabs() {
  let resolve!: (value: { list: TabInfo[] }) => void;
  const promise = new Promise<{ list: TabInfo[] }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  route.query = {};
  store.platforms = [];
  store.loading = true;
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

describe.each(["new-song", "new-album"] as const)("%s 平台与分类", (name) => {
  it("等待平台列表，只显示启用且支持两项能力的平台", async () => {
    route.query = { platform: "only-tags", tab_id: "second" };
    const fetchTabs = vi.fn(async () => ({ list: [tab("first"), tab("second")] }));
    const state = setup(name, fetchTabs);
    expect(state.platformLoading.value).toBe(true);
    expect(fetchTabs).not.toHaveBeenCalled();
    store.platforms = [
      platform("only-tags", 1n),
      platform("only-list", 2n),
      platform("disabled", requiredFlags, 0),
      platform("qq", 7n),
    ];
    store.loading = false;
    await flush();
    expect(state.platforms.value.map((item) => item.id)).toEqual(["qq"]);
    expect(state.platformLoading.value).toBe(false);
    expect(fetchTabs).toHaveBeenCalledExactlyOnceWith("qq");
    expect(replace).toHaveBeenCalledExactlyOnceWith({ name, query: { platform: "qq" } });
    expect(state.tabId.value).toBe("first");
    state.platformChange("only-list");
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("保留有效的深链接；换分类不重载分类列表，换平台则重新加载", async () => {
    route.query = { platform: "other", tab_id: "second" };
    store.platforms = [platform("qq"), platform("other")];
    const fetchTabs = vi.fn(async (id: string) => ({
      list: [tab("first", id), tab("second", id)],
    }));
    const state = setup(name, fetchTabs);
    await flush();
    expect(fetchTabs).toHaveBeenCalledExactlyOnceWith("other");
    expect(state.tabId.value).toBe("second");
    state.tagChange("first");
    expect(replace).toHaveBeenLastCalledWith({
      name,
      query: { platform: "other", tab_id: "first" },
    });
    await flush();
    expect(state.tabId.value).toBe("first");
    expect(fetchTabs).toHaveBeenCalledTimes(1);
    state.platformChange("qq");
    expect(replace).toHaveBeenLastCalledWith({ name, query: { platform: "qq" } });
    await flush();
    expect(fetchTabs).toHaveBeenLastCalledWith("qq");
    expect(state.tabId.value).toBe("first");
  });

  it("快速切换平台时忽略旧请求", async () => {
    store.platforms = [platform("old"), platform("new")];
    const old = deferredTabs();
    const current = deferredTabs();
    const fetchTabs = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const state = setup(name, fetchTabs);
    state.platformChange("new");
    await nextTick();
    old.resolve({ list: [tab("old", "old")] });
    await flush();
    expect(state.tabs.value).toBeNull();
    expect(state.loading.value).toBe(true);
    current.resolve({ list: [tab("new", "new")] });
    await flush();
    expect(fetchTabs.mock.calls).toEqual([["old"], ["new"]]);
    expect(state.tabs.value).toEqual([tab("new", "new")]);
    expect(state.tabId.value).toBe("new");
  });

  it("无可用平台时不发请求；分类加载失败可重试", async () => {
    const fetchTabs = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ list: [] });
    const state = setup(name, fetchTabs);
    store.platforms = [platform("unavailable", 1n)];
    store.loading = false;
    await flush();
    expect(state.platform.value).toBeUndefined();
    expect(fetchTabs).not.toHaveBeenCalled();
    store.platforms = [platform("qq")];
    await flush();
    expect(state.failed.value).toBe(true);
    await state.retry();
    expect(state.failed.value).toBe(false);
    expect(state.tabs.value).toEqual([]);
    expect(state.tabId.value).toBeUndefined();
  });

  it("作用域销毁后不写回尚未完成的请求", async () => {
    store.platforms = [platform("qq")];
    const request = deferredTabs();
    const fetchTabs = vi.fn(() => request.promise);
    const state = setup(name, fetchTabs);
    scopes[0].stop();
    request.resolve({ list: [tab("late")] });
    await flush();
    expect(state.tabs.value).toBeNull();
    expect(fetchTabs).toHaveBeenCalledTimes(1);
  });
});
