import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  likeSong: vi.fn(),
  songs: vi.fn(),
  playlists: vi.fn(),
  categories: vi.fn(),
  request: vi.fn(),
  setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
}));
vi.mock("@/platform/applicationStorage", () => ({
  applicationStorage: {},
  createApplicationDatabase: () => ({ setItem: mocks.setItem }),
}));
vi.mock("@/utils/song", () => ({}));
vi.mock("@/utils/request", () => ({ requestHemusic: mocks.request }));
vi.mock("@/api/playlist", () => ({ playlistCategories: mocks.categories }));
vi.mock("@/api/user", () => ({
  userAccount: mocks.account,
  userFavouriteSong: mocks.songs,
  likeSong: mocks.likeSong,
}));
vi.mock("@/api/userplaylist", () => ({ getUserPlaylists: mocks.playlists }));
vi.mock("@/api/auth", () => ({}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores", async () => ({
  useDataStore: (await import("@/stores/data")).useDataStore,
}));

import { useDataStore } from "@/stores/data";
import { usePlatformStore } from "@/stores/platform";
import {
  updateUserAccountInfo,
  updateUserLikeSongs,
  updateUserCreatedPlaylist,
  toLikeSong,
} from "./auth";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.request.mockResolvedValue({ list: [] });
});

describe("身份切换缓存", () => {
  it("退出清除用户和分类缓存，重新加载公开平台，不清实例存储", async () => {
    const data = useDataStore();
    const platform = usePlatformStore();
    Object.assign(data, { token: "old", refreshToken: "old-refresh", userLoginStatus: true });
    data.userData.id = "old-user";
    data.userLikeData.songs = [{ id: "old-song", platform: "qq" }];
    data.playlistCategories.qq = [];
    platform.loaded = true;
    await data.clearUserData();
    expect(data.token).toBe("");
    expect(data.userData.id).toBe("");
    expect(data.userLikeData.songs).toEqual([]);
    expect(data.playlistCategories).toEqual({});
    expect(data.identityRevision).toBe(1);
    expect(platform.loaded).toBe(true);
    expect(mocks.request).toHaveBeenCalledWith({ url: "/v1/platforms", params: {} });
    expect(mocks.setItem.mock.calls.map(([key]) => key)).not.toContain("he-client-instance-id");
  });

  it("收藏操作等待期间退出，不回填旧收藏列表", async () => {
    const data = useDataStore();
    data.userLoginStatus = true;
    data.token = "old";
    data.userData.id = "old-user";
    let finish!: () => void;
    mocks.likeSong.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const run = toLikeSong(
      {
        id: "fixture",
        platform: "qq",
        name: "fixture",
        subtitle: "",
        duration: 1,
        mv_id: "",
        album: "",
        links: [],
        cover: "",
      },
      true,
    );
    await data.clearUserData();
    finish();
    await run;
    expect(data.userLikeData.songs).toEqual([]);
    expect(
      mocks.setItem.mock.calls.filter(
        ([key, value]) => key === "songs" && Array.isArray(value) && value.length,
      ),
    ).toEqual([]);
  });

  it.each(["account", "songs", "playlists", "categories"] as const)(
    "身份切换后丢弃旧 %s 响应",
    async (kind) => {
      const data = useDataStore();
      data.userLoginStatus = true;
      data.token = "old";
      data.userData.id = "old-user";
      let finish!: (value: unknown) => void;
      mocks[kind].mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const run =
        kind === "account"
          ? updateUserAccountInfo()
          : kind === "songs"
            ? updateUserLikeSongs()
            : kind === "playlists"
              ? updateUserCreatedPlaylist()
              : data.getPlaylistCategories("qq");
      await data.clearUserData();
      finish({ id: "old-user", list: [{ id: "stale" }], groups: [{ id: "stale" }] });
      await run;
      expect(data.userData.id).toBe("");
      expect(data.userLikeData.songs).toEqual([]);
      expect(data.userCreatedPlaylist).toEqual([]);
      expect(data.playlistCategories).toEqual({});
    },
  );
});
