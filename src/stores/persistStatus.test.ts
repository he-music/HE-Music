import { createApp, nextTick } from "vue";
import persistedstate from "pinia-plugin-persistedstate";
import { afterEach, expect, it, vi } from "vitest";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(saved?: string, memoryLastSeek = true) {
  const values = new Map<string, string>();
  if (saved !== undefined) values.set("status-store", saved);
  if (!memoryLastSeek) {
    values.set("setting-store", JSON.stringify({ memoryLastSeek: false }));
  }
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  // Pinia 开发工具也会读取 localStorage，必须在导入 Pinia 前提供浏览器存储。
  vi.stubGlobal("localStorage", storage);
  // 设置 store 的 storage 在模块加载时绑定，每次模拟独立启动时重新加载。
  vi.resetModules();
  const { persistStatus } = await import("./persistStatus");
  const { useSettingStore } = await import("./setting");
  const { createPinia, disposePinia, defineStore } = await import("pinia");
  const { useStatusStore } = await import("./status");
  const pinia = createPinia().use(persistedstate).use(persistStatus);
  createApp({}).use(pinia);
  const store = useStatusStore(pinia);
  const settingStore = useSettingStore(pinia);
  disposers.push(() => disposePinia(pinia));
  return { store, settingStore, storage, values, pinia, defineStore };
}

it.each(["default", "title", "duration"])(
  "旧版默认排序方式在字段 %s 下恢复为原始顺序",
  async (field) => {
    const { store, storage, values } = await fixture(
      JSON.stringify({ listSortField: field, listSortOrder: "default", playVolume: 0.8 }),
    );
    await nextTick();
    expect(store.listSortField).toBe("default");
    expect(store.listSortOrder).toBe("asc");
    expect(store.playVolume).toBe(0.8);
    expect(storage.setItem).not.toHaveBeenCalled();
    store.$persist();
    expect(JSON.parse(values.get("status-store")!)).toMatchObject({
      listSortField: "default",
      listSortOrder: "asc",
    });
  },
);

it("保留章节排序的降序，切到默认字段不改方向，重置时恢复默认字段和升序", async () => {
  const { store, values } = await fixture(
    JSON.stringify({ listSortField: "chapter", listSortOrder: "desc" }),
  );
  expect(store.listSortField).toBe("chapter");
  expect(store.listSortOrder).toBe("desc");
  store.listSortField = "default";
  await nextTick();
  expect(store.listSortOrder).toBe("desc");
  expect(JSON.parse(values.get("status-store")!)).toMatchObject({
    listSortField: "default",
    listSortOrder: "desc",
  });
  store.resetPlayStatus();
  expect(store.listSortField).toBe("default");
  expect(store.listSortOrder).toBe("asc");
});

it("歌词、频谱等高频无关状态变化不触发持久化、序列化或存储读取", async () => {
  const { store, storage } = await fixture();
  store.duration = 10000;
  await nextTick();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  const serialize = vi.spyOn(JSON, "stringify");
  const persist = vi.spyOn(store, "$persist");
  for (let frame = 16; frame < 1000; frame += 16) {
    store.$patch({
      duration: 10000,
      progress: frame / 100,
      lyricIndex: Math.floor(frame / 100),
      playStatus: true,
      spectrumsData: [frame],
      autoClose: { remainTime: frame },
    });
    await nextTick();
  }
  expect(persist).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("恢复原有存储键和字段，忽略非持久化字段且不在初始化时回写", async () => {
  const { store, storage } = await fixture(
    JSON.stringify({
      playVolume: 0.8,
      backgroundConfig: { scale: 1.5 },
      currentTime: 9000,
      progress: 90,
      lyricIndex: 10,
    }),
  );
  await nextTick();
  expect(store.playVolume).toBe(0.8);
  expect(store.backgroundConfig.scale).toBe(1.5);
  expect(store.backgroundConfig.blur).toBe(0);
  expect(store.currentTime).toBe(9000);
  expect(store.progress).toBe(0);
  expect(store.lyricIndex).toBe(-1);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("十秒检查点保存毫秒位置，同一周期不重复序列化，显式跳转后可恢复", async () => {
  const { store, storage, values } = await fixture();
  const serialize = vi.spyOn(JSON, "stringify");
  for (const currentTime of [250, 1000, 5000, 9999]) {
    store.currentTime = currentTime;
    await nextTick();
  }
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(serialize).not.toHaveBeenCalled();
  store.currentTime = 10123;
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(10123);
  for (const currentTime of [11000, 15000, 19999]) {
    store.currentTime = currentTime;
    await nextTick();
  }
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(serialize).toHaveBeenCalledTimes(1);
  store.currentTime = 20001;
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  store.currentTime = 19876;
  store.$persist();
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(3);
  const saved = values.get("status-store");
  store.$dispose();
  const restored = await fixture(saved);
  await nextTick();
  expect(restored.store.currentTime).toBe(19876);
  expect(restored.storage.setItem).not.toHaveBeenCalled();
});

it("模拟连续播放一分钟只写入六次进度检查点", async () => {
  const { store, storage } = await fixture();
  store.playStatus = true;
  await nextTick();
  const serialize = vi.spyOn(JSON, "stringify");
  for (let currentTime = 250; currentTime <= 60000; currentTime += 250) {
    store.currentTime = currentTime;
    await nextTick();
  }
  expect(storage.setItem).toHaveBeenCalledTimes(6);
  expect(serialize).toHaveBeenCalledTimes(6);
});

it("关闭记忆位置时不恢复旧进度，进度变化不序列化或写入，其他设置照常保存", async () => {
  const { store, storage, values } = await fixture(JSON.stringify({ currentTime: 9000 }), false);
  await nextTick();
  expect(store.currentTime).toBe(0);
  expect(storage.setItem).not.toHaveBeenCalled();

  storage.getItem.mockClear();
  const serialize = vi.spyOn(JSON, "stringify");
  for (let currentTime = 250; currentTime <= 10000; currentTime += 250) {
    store.currentTime = currentTime;
    await nextTick();
  }
  expect(serialize).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(storage.getItem).not.toHaveBeenCalled();

  store.playVolume = 0.8;
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(values.get("status-store")!).playVolume).toBe(0.8);
  expect(JSON.parse(values.get("status-store")!)).not.toHaveProperty("currentTime");

  store.$persist();
  expect(JSON.parse(values.get("status-store")!)).not.toHaveProperty("currentTime");
});

it("切换记忆位置开关会更新快照，重新开启后按十秒检查点保存当前进度", async () => {
  const { store, settingStore, storage, values } = await fixture();
  const statusWrites = () => storage.setItem.mock.calls.filter(([key]) => key === "status-store");
  store.currentTime = 10123;
  await nextTick();
  expect(statusWrites()).toHaveLength(1);

  settingStore.memoryLastSeek = false;
  await nextTick();
  expect(statusWrites()).toHaveLength(2);
  expect(JSON.parse(values.get("status-store")!)).not.toHaveProperty("currentTime");

  store.currentTime = 15000;
  await nextTick();
  expect(statusWrites()).toHaveLength(2);

  settingStore.memoryLastSeek = true;
  await nextTick();
  expect(statusWrites()).toHaveLength(3);
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(15000);

  store.currentTime = 15999;
  await nextTick();
  expect(statusWrites()).toHaveLength(3);
  store.currentTime = 20000;
  await nextTick();
  expect(statusWrites()).toHaveLength(4);
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(20000);
});

it("业务字段、嵌套对象和数组变化各保存一次，同步批量修改合并保存", async () => {
  const { store, storage, values } = await fixture();
  store.playVolume = 0.8;
  store.duration = 10000;
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  store.backgroundConfig.scale = 1.5;
  store.eqBands[0] = 3;
  store.currentTimeOffsetMap["test-song"] = 0.25;
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  expect(JSON.parse(values.get("status-store")!)).toMatchObject({
    playVolume: 0.8,
    duration: 10000,
    backgroundConfig: { scale: 1.5 },
    eqBands: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    currentTimeOffsetMap: { "test-song": 0.25 },
  });
  delete store.currentTimeOffsetMap["test-song"];
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(3);
  expect(JSON.parse(values.get("status-store")!).currentTimeOffsetMap).toEqual({});
  expect(storage.getItem.mock.calls.filter(([key]) => key === "status-store")).toHaveLength(1);
});

it("清空存储后可显式保存，显式恢复和重置仍然正常", async () => {
  const { store, storage, values } = await fixture();
  store.playVolume = 0.8;
  await nextTick();
  values.clear();
  store.$persist();
  expect(JSON.parse(values.get("status-store")!).playVolume).toBe(0.8);
  values.set("status-store", JSON.stringify({ playVolume: 0.3, currentTime: 999 }));
  store.$hydrate();
  await nextTick();
  expect(store.playVolume).toBe(0.3);
  expect(store.currentTime).toBe(999);
  store.$reset();
  await nextTick();
  expect(JSON.parse(values.get("status-store")!).playVolume).toBe(0.7);
  expect(storage.setItem).toHaveBeenCalledTimes(4);
});

it("暂停、退出落盘和隐藏页面保存检查点之间的最新位置，释放 store 后撤销订阅", async () => {
  const windowEvents = new EventTarget();
  const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("document", documentEvents);
  const { store, storage, values } = await fixture();
  const { flushApplicationWrites } = await import("@/platform/applicationStorage");
  store.playStatus = true;
  store.currentTime = 1234;
  await nextTick();
  expect(storage.setItem).not.toHaveBeenCalled();
  store.playStatus = false;
  await nextTick();
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(1234);
  store.currentTime = 2345;
  await flushApplicationWrites();
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(2345);
  store.currentTime = 3456;
  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(3456);
  store.currentTime = 4567;
  windowEvents.dispatchEvent(new Event("pagehide"));
  expect(JSON.parse(values.get("status-store")!).currentTime).toBe(4567);
  await nextTick();
  store.$dispose();
  storage.setItem.mockClear();
  store.currentTime = 5678;
  windowEvents.dispatchEvent(new Event("pagehide"));
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await flushApplicationWrites();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("释放 store 后停止监听，其他 store 仍由原插件持久化", async () => {
  const { store, storage, pinia, defineStore } = await fixture();
  const other = defineStore("other-persisted", {
    state: () => ({ enabled: false }),
    persist: { storage },
  })(pinia);
  other.enabled = true;
  await nextTick();
  expect(storage.setItem).toHaveBeenLastCalledWith("other-persisted", '{"enabled":true}');
  store.$dispose();
  storage.setItem.mockClear();
  store.playVolume = 0.9;
  await nextTick();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("损坏快照和存储写入异常不会打断状态更新，后续仍可保存", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { store, storage, values } = await fixture("{invalid");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(store.playVolume).toBe(0.7);
  storage.setItem.mockImplementationOnce(() => {
    throw new Error("quota exceeded");
  });
  store.playVolume = 0.8;
  await nextTick();
  expect(warn).toHaveBeenCalledTimes(2);
  expect(store.playVolume).toBe(0.8);
  store.playVolume = 0.9;
  await nextTick();
  expect(JSON.parse(values.get("status-store")!).playVolume).toBe(0.9);
});
