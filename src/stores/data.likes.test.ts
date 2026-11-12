import { createPinia, setActivePinia } from "pinia";
import { effectScope, nextTick, watchEffect } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setItem: vi.fn(async () => {}),
  keys: vi.fn<() => Promise<string[]>>(async () => []),
  getItem: vi.fn(),
  loadPlatforms: vi.fn(async () => {}),
  invalidatePlatforms: vi.fn(),
}));
vi.mock("@/platform/applicationStorage", () => ({
  applicationStorage: {},
  createApplicationDatabase: () => ({
    setItem: mocks.setItem,
    keys: mocks.keys,
    getItem: mocks.getItem,
  }),
}));
vi.mock("@/api/playlist", () => ({ playlistCategories: vi.fn() }));
vi.mock("@/api/artist", () => ({ artistFilters: vi.fn() }));
vi.mock("@/api/video", () => ({ mvFilters: vi.fn() }));
vi.mock("./platform", () => ({
  usePlatformStore: () => ({
    loadPlatforms: mocks.loadPlatforms,
    invalidatePlatforms: mocks.invalidatePlatforms,
  }),
}));
vi.mock("@/utils/song", () => ({}));

import { useDataStore } from "./data";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.keys.mockResolvedValue([]);
});

describe("收藏歌曲索引", () => {
  it("按平台及完整 id 区分收藏，分隔符与对象属性名不会串键", () => {
    const store = useDataStore();
    expect(store.isLikeSong()).toBe(false);
    store.userLikeData.songs = [
      { platform: "qq", id: "1" },
      { platform: "a:b", id: "c" },
      { platform: "__proto__", id: "constructor" },
      { platform: "", id: "" },
    ];
    expect(store.isLikeSong({ platform: "qq", id: "1" })).toBe(true);
    expect(store.isLikeSong({ platform: "netease", id: "1" })).toBe(false);
    expect(store.isLikeSong({ platform: "a", id: "b:c" })).toBe(false);
    expect(store.isLikeSong({ platform: "a:b", id: "c" })).toBe(true);
    expect(store.isLikeSong({ platform: "__proto__", id: "constructor" })).toBe(true);
    expect(store.isLikeSong()).toBe(true);
  });

  it("添加、删除、标识修改、数组与整体替换立即更新，已取得的判断函数也读取最新索引", async () => {
    const store = useDataStore();
    const isLikeSong = store.isLikeSong;
    const song = { platform: "qq", id: "1" };
    store.userLikeData.songs.push({ ...song });
    expect(isLikeSong(song)).toBe(true);
    store.userLikeData.songs.splice(0, 1);
    expect(isLikeSong(song)).toBe(false);
    await store.setUserLikeData("songs", [{ ...song }]);
    expect(isLikeSong(song)).toBe(true);
    store.userLikeData.songs[0].id = "2";
    expect(isLikeSong(song)).toBe(false);
    expect(isLikeSong({ platform: "qq", id: "2" })).toBe(true);
    store.userLikeData = { songs: [], playlists: [], artists: [], albums: [], mvs: [] };
    expect(isLikeSong({ platform: "qq", id: "2" })).toBe(false);
  });

  it("本地收藏加载与登出清空都会使索引更新", async () => {
    const store = useDataStore();
    const song = { platform: "qq", id: "loaded" };
    expect(store.isLikeSong(song)).toBe(false);
    mocks.keys.mockResolvedValueOnce([]).mockResolvedValueOnce(["songs"]);
    mocks.getItem.mockResolvedValueOnce([song]);
    await store.loadData();
    expect(store.isLikeSong(song)).toBe(true);
    const clearing = store.clearUserData();
    expect(store.isLikeSong(song)).toBe(false);
    await clearing;
    expect(store.isLikeSong(song)).toBe(false);
  });

  it("反复查询复用派生索引，无关状态不重建索引或触发收藏消费者更新", async () => {
    const store = useDataStore();
    const song = { platform: "qq", id: "1" };
    store.userLikeData.songs = [song];
    const index = store.likedSongIndex;
    const consume = vi.fn();
    const scope = effectScope();
    scope.run(() => watchEffect(() => consume(store.isLikeSong(song))));
    for (let i = 0; i < 100; i++) expect(store.isLikeSong(song)).toBe(true);
    store.searchHistory.push("query");
    store.userLikeData.albums = [];
    await nextTick();
    expect(store.likedSongIndex).toBe(index);
    expect(consume).toHaveBeenCalledTimes(1);
    store.userLikeData.songs = [];
    await nextTick();
    expect(store.likedSongIndex).not.toBe(index);
    expect(consume).toHaveBeenLastCalledWith(false);
    expect(consume).toHaveBeenCalledTimes(2);
    scope.stop();
  });
});
