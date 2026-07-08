import {
  likeAlbum,
  likePlaylist,
  likeArtist,
  likeSong,
  unlikeAlbum,
  unlikePlaylist,
  unlikeArtist,
  unlikeSong,
  userAccount,
  userFavouriteAlbum,
  userFavouriteArtist,
  userFavouritePlaylist,
  userFavouriteSong,
} from "@/api/user";
import { useDataStore } from "@/stores";
import { debounce, isFunction } from "lodash-es";
import { isElectron } from "./env";
import type {
  AlbumInfo,
  IDPlatformInfo,
  PlaylistInfo,
  ArtistInfo,
  SongInfo,
} from "@/types/main.hemusic";
import { deleteSongFromPlaylist, getUserPlaylists } from "@/api/userplaylist";
import { t } from "@/i18n";
import { logoutApi } from "@/api/auth";

/**
 * 用户是否登录
 */
export const isLogin = (): boolean => {
  const dataStore = useDataStore();
  return dataStore.userLoginStatus;
};

// 退出登录
export const toLogout = async () => {
  const dataStore = useDataStore();
  // 调用后端登出（失败也继续清理本地状态）
  try {
    await logoutApi();
  } catch (error) {
    console.error("后端登出失败：", error);
  }
  sessionStorage.clear();
  // 清除用户数据
  await dataStore.clearUserData();
  window.$message.success(t("message.logout_success"));
};

export const updateUserAccountInfo = async () => {
  if (!isLogin()) return;
  const dataStore = useDataStore();
  // userId
  const userInfo = await userAccount();
  // 更改用户信息
  dataStore.userData = {
    ...userInfo,
  };
};
// 更新用户信息
export const updateUserData = async () => {
  try {
    if (!isLogin()) return;

    // 先更新用户信息
    await updateUserAccountInfo();

    // 获取用户喜欢数据
    const allUserLikeResult = await Promise.allSettled([
      updateUserLikeSongs(),
      updateUserCreatedPlaylist(),
      updateUserLikePlaylist(),
      updateUserLikeArtists(),
      updateUserLikeAlbums(),
      // updateUserLikeMvs(),
      // 每日推荐
      // updateDailySongsData(),
    ]);
    // 若部分失败
    const hasFailed = allUserLikeResult.some((result) => result.status === "rejected");
    if (hasFailed) throw new Error("Failed to update some user data");
  } catch (error) {
    console.error("❌ Error updating user data:", error);
    throw error;
  }
};

// 更新用户喜欢歌曲
export const updateUserLikeSongs = async () => {
  const dataStore = useDataStore();
  if (!isLogin() || !dataStore.userData.id) return;
  const result = await userFavouriteSong(0, 1);
  dataStore.setUserLikeData("songs", result.list);
};

// 更新用户喜欢歌单
export const updateUserLikePlaylist = async () => {
  const dataStore = useDataStore();
  const userId = dataStore.userData.id;
  if (!isLogin() || !userId) return;
  const result = await userFavouritePlaylist(0, 1);
  dataStore.setUserLikeData("playlists", result.list);
};

// 更新用户喜欢歌手
export const updateUserLikeArtists = async () => {
  const dataStore = useDataStore();
  const userId = dataStore.userData.id;
  if (!isLogin() || !userId) return;
  const result = await userFavouriteArtist(0, 1);
  dataStore.setUserLikeData("artists", result.list);
};

// 更新用户喜欢专辑
export const updateUserLikeAlbums = async () => {
  const dataStore = useDataStore();
  const userId = dataStore.userData.id;
  if (!isLogin() || !userId) return;
  const result = await userFavouriteAlbum(0, 1);
  dataStore.setUserLikeData("albums", result.list);
};

// 更新用户喜欢歌单
export const updateUserCreatedPlaylist = async () => {
  const dataStore = useDataStore();
  const userId = dataStore.userData.id;
  if (!isLogin() || !userId) return;
  const result = await getUserPlaylists(0, 1);
  dataStore.userCreatedPlaylist = result.list;
};

// 喜欢歌曲
export const toLikeSong = debounce(
  async (song: SongInfo, like: boolean) => {
    if (!isLogin()) {
      window.$message.warning(t("message.login_required"));
      return;
    }
    const dataStore = useDataStore();
    const { id, platform, path } = song;
    if (path) {
      window.$message.warning(t("message.local_song_not_support_operation"));
      return;
    }
    const likeList = dataStore.userLikeData.songs;

    try {
      if (like) {
        await likeSong(id, platform);
        likeList.push({ id, platform });
        window.$message.success(t("message.my_favorite_music_added"));
      } else {
        await unlikeSong(id, platform);
        const idx = likeList.findIndex((item) => item.id === id && item.platform === platform);
        likeList.splice(idx, 1);
        window.$message.success(t("message.my_favorite_music_deleted"));
      }
      dataStore.setUserLikeData("songs", likeList);

      const likeSongList = dataStore.userCreatedPlaylist.find((item) => item.is_default == 1);
      if (likeSongList) {
        likeSongList.song_count = likeList.length.toString();
      }
      // ipc
      if (isElectron) window.electron.ipcRenderer.send("like-status-change", like);
    } catch {
      window.$message.error(
        like
          ? t("message.my_favorite_music_added_fail")
          : t("message.my_favorite_music_deleted_fail"),
      );
      return;
    }
  },
  300,
  { leading: true, trailing: false },
);

// 收藏/取消收藏歌单
export const toLikePlaylist = debounce(
  async (info: PlaylistInfo, like: boolean) => {
    if (!info || !info.id || !info.platform) return;
    if (!isLogin()) {
      window.$message.warning(t("message.login_required"));
      return;
    }

    try {
      if (like) {
        await likePlaylist(info.id, info.platform, info.name, info.cover, info.creator);
      } else {
        await unlikePlaylist(info.id, info.platform);
      }
      await updateUserLikePlaylist();
      // 更新歌单
      window.$message.success(
        like ? t("message.collected_playlist_added") : t("message.collected_deleted"),
      );
    } catch {
      window.$message.success(
        like ? t("message.collected_playlist_added_fail") : t("message.collected_deleted_fail"),
      );
      return;
    }
  },
  300,
  { leading: true, trailing: false },
);

// 收藏/取消收藏歌手
export const toLikeArtist = debounce(
  async (info: ArtistInfo, like: boolean) => {
    if (!info || !info.id || !info.platform) return;
    if (!isLogin()) {
      window.$message.warning(t("message.login_required"));
      return;
    }
    try {
      if (like) {
        await likeArtist(info.id, info.platform, info.name, info.cover);
      } else {
        await unlikeArtist(info.id, info.platform);
      }
      await updateUserLikeArtists();
      window.$message.success(
        like ? t("message.collected_artist_added") : t("message.collected_deleted"),
      );
    } catch {
      window.$message.success(
        like ? t("message.collected_artist_added_fail") : t("message.collected_deleted_fail"),
      );
      return;
    }
  },
  300,
  { leading: true, trailing: false },
);

// 喜欢取消喜欢专辑
export const toLikeAlbum = debounce(
  async (info: AlbumInfo, like: boolean) => {
    if (!info || !info.id || !info.platform) return;
    if (!isLogin()) {
      window.$message.warning(t("message.login_required"));
      return;
    }

    try {
      if (like) {
        await likeAlbum(info.id, info.platform, info.name, info.cover, info.artists);
      } else {
        await unlikeAlbum(info.id, info.platform);
      }
      await updateUserLikeAlbums();
      // 更新歌单
      window.$message.success(
        like ? t("message.collected_album_added") : t("message.collected_deleted"),
      );
    } catch {
      window.$message.success(
        like ? t("message.collected_album_added_fail") : t("message.collected_deleted_fail"),
      );
      return;
    }
  },
  300,
  { leading: true, trailing: false },
);

/**
 * 删除歌曲
 * @param pid 歌单id
 * @param ids 要删除的歌曲id
 */
export const deleteSongs = async (pid: string, ids: IDPlatformInfo[], callback?: () => void) => {
  try {
    window.$dialog.warning({
      title: t("common.delete"),
      content: t("modal.song_delete_confirm", ids.length),
      positiveText: t("common.delete"),
      negativeText: t("common.cancel"),
      onPositiveClick: async () => {
        try {
          await deleteSongFromPlaylist(pid, ids);
          if (isFunction(callback)) callback();
          window.$message.success(t("message.delete_success"));
        } catch {
          window.$message.error(t("message.delete_fail"));
        }
      },
    });
  } catch (error) {
    console.error("❌ Error deleting songs:", error);
    throw error;
  }
};
