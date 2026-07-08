// 获取用户喜欢的歌单
import { requestHemusic } from "@/utils/request";
import type { IDPlatformInfo } from "@/types/main.hemusic";

export const createUserPlaylist = (name: string, cover: string, description: string) => {
  return requestHemusic({
    url: "/v1/user/playlist",
    method: "POST",
    data: {
      name,
      cover,
      description,
    },
  });
};
export const updateUserPlaylist = (
  id: string,
  name: string,
  cover: string,
  description: string,
) => {
  return requestHemusic({
    url: "/v1/user/playlist",
    method: "PUT",
    data: {
      id,
      name,
      cover,
      description,
    },
  });
};

export const getUserPlaylists = (page_size: number = 50, page_index: number = 1) => {
  return requestHemusic({
    url: "/v1/user/playlists",
    method: "GET",
    params: {
      page_size,
      page_index,
    },
  });
};

export const deleteUserPlaylist = (id: string) => {
  return requestHemusic({
    url: "/v1/user/playlist",
    method: "DELETE",
    data: {
      id,
    },
  });
};

export const getUserPlaylistDetail = (id: string) => {
  return requestHemusic({
    url: "/v1/user/playlist",
    method: "GET",
    params: {
      id,
    },
  });
};

export const listUserPlaylistSongs = (
  id: string,
  page_index: number = 1,
  page_size: number = 1000,
) => {
  return requestHemusic({
    url: "/v1/user/playlist/songs",
    method: "GET",
    params: {
      id,
      page_size,
      page_index,
    },
  });
};

export const addSongToPlaylist = (id: string, songs: IDPlatformInfo[]) => {
  return requestHemusic({
    url: "/v1/user/playlist/song",
    method: "POST",
    data: {
      id,
      songs,
    },
  });
};

export const deleteSongFromPlaylist = (id: string, songs: IDPlatformInfo[]) => {
  return requestHemusic({
    url: "/v1/user/playlist/song",
    method: "DELETE",
    data: {
      id,
      songs,
    },
  });
};
