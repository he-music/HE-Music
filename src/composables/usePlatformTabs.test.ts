import { effectScope, nextTick, reactive, ref, type EffectScope } from "vue";
import type { RouteLocationNormalized } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabInfo } from "@/types/main.hemusic";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  beforeRouteUpdate:
    vi.fn<(callback: (to: Pick<RouteLocationNormalized, "name" | "query">) => void) => void>(),
}));
const currentRoute = ref({ query: {} as Record<string, string> });
const platformStore = reactive({ platforms: [] as { id: string }[] });
vi.mock("vue-router", () => ({
  useRouter: () => ({ currentRoute, replace: mocks.replace }),
  onBeforeRouteUpdate: mocks.beforeRouteUpdate,
}));
vi.mock("@/stores/platform", () => ({ usePlatformStore: () => platformStore }));

import { usePlatformTabs } from "./usePlatformTabs";

const scopes: EffectScope[] = [];
function setup(
  routeName: "new-song" | "new-album",
  fetchTabs: (platform: string) => Promise<{ list: TabInfo[] }>,
) {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => usePlatformTabs(routeName, fetchTabs))!;
}
const tab = (id: string, platform = "qq"): TabInfo => ({ id, platform, name: id });
const flush = async () => {
  await Promise.resolve();
  await nextTick();
};
function deferred() {
  let resolve!: (value: { list: TabInfo[] }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ list: TabInfo[] }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRoute.value = { query: {} };
  platformStore.platforms = [];
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

describe.each(["new-song", "new-album"] as const)("%s 平台标签", (routeName) => {
  it("等待平台列表，平台无效时回退首个平台、标签无效时选择首项", async () => {
    currentRoute.value.query = { platform: "missing", tab_id: "missing" };
    const fetchTabs = vi.fn(async () => ({ list: [tab("first"), tab("second")] }));
    const state = setup(routeName, fetchTabs);
    expect(fetchTabs).not.toHaveBeenCalled();
    platformStore.platforms = [{ id: "qq" }];
    await flush();
    await flush();
    expect(fetchTabs).toHaveBeenCalledExactlyOnceWith("qq");
    expect(state.tab_id.value).toBe("first");
    expect(state.loading.value).toBe(false);
    expect(state.failed.value).toBe(false);
    state.tagChange("second");
    expect(mocks.replace).toHaveBeenCalledWith({
      name: routeName,
      query: { platform: "qq", tab_id: "second" },
    });
  });

  it("保留有效初始平台和标签，同页面 route update 同步标签且不重载", async () => {
    currentRoute.value.query = { platform: "other", tab_id: "second" };
    platformStore.platforms = [{ id: "qq" }, { id: "other" }];
    const fetchTabs = vi.fn(async () => ({
      list: [tab("first", "other"), tab("second", "other")],
    }));
    const state = setup(routeName, fetchTabs);
    await flush();
    expect(fetchTabs).toHaveBeenCalledExactlyOnceWith("other");
    expect(state.tab_id.value).toBe("second");
    const updateRoute = mocks.beforeRouteUpdate.mock.calls[0][0];
    updateRoute({ name: "unrelated", query: { tab_id: "ignored" } });
    expect(state.tab_id.value).toBe("second");
    updateRoute({ name: routeName, query: { tab_id: "first", platform: "other" } });
    expect(state.tab_id.value).toBe("first");
    expect(fetchTabs).toHaveBeenCalledTimes(1);
    state.tagChange("second");
    expect(mocks.replace).toHaveBeenLastCalledWith({
      name: routeName,
      query: { platform: "other", tab_id: "second" },
    });
  });

  it("平台切换后仅应用新请求，旧响应不覆盖标签或清除加载状态", async () => {
    platformStore.platforms = [{ id: "old" }];
    const old = deferred();
    const current = deferred();
    const fetchTabs = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const state = setup(routeName, fetchTabs);
    platformStore.platforms = [{ id: "new" }];
    await nextTick();
    old.resolve({ list: [tab("old", "old")] });
    await flush();
    expect(state.tabs.value).toBeNull();
    expect(state.loading.value).toBe(true);
    current.resolve({ list: [tab("new", "new")] });
    await flush();
    expect(fetchTabs.mock.calls).toEqual([["old"], ["new"]]);
    expect(state.tabs.value).toEqual([tab("new", "new")]);
    expect(state.tab_id.value).toBe("new");
    expect(state.loading.value).toBe(false);
  });

  it("失败可重试，空响应清空默认标签", async () => {
    platformStore.platforms = [{ id: "qq" }];
    const fetchTabs = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ list: [] });
    const state = setup(routeName, fetchTabs);
    await flush();
    expect(state.failed.value).toBe(true);
    expect(state.loading.value).toBe(false);
    await state.retry();
    await nextTick();
    expect(state.failed.value).toBe(false);
    expect(state.tabs.value).toEqual([]);
    expect(state.tab_id.value).toBe("");
  });

  it("作用域销毁后不写回尚未完成的请求", async () => {
    platformStore.platforms = [{ id: "qq" }];
    const request = deferred();
    const fetchTabs = vi.fn(() => request.promise);
    const state = setup(routeName, fetchTabs);
    scopes[0].stop();
    request.resolve({ list: [tab("late")] });
    await flush();
    expect(state.tabs.value).toBeNull();
    platformStore.platforms = [{ id: "new" }];
    await nextTick();
    expect(fetchTabs).toHaveBeenCalledTimes(1);
  });
});
