import request, { requestHemusic } from "@/utils/request";

/**
 * 获取用户账号信息
 */
export const userAccount = () => {
  return requestHemusic({
    url: "/v1/user/info",
    params: {},
  });
};

// 获取用户详情
export const userDetail = (uid: number) => {
  return request({
    url: "/user/detail",
    params: {
      uid,
      timestamp: Date.now(),
    },
  });
};

// 获取用户喜欢的歌单
export const userFavouritePlaylist = (page_size: number = 50, page_index: number = 1) => {
  return requestHemusic({
    url: "/v1/user/favourite/playlists",
    params: {
      page_index,
      page_size,
    },
  });
};

/**
 * 收藏歌单
 */
export const likePlaylist = (
  id: string,
  platform: string,
  name: string,
  cover: string,
  creator: string,
) => {
  return requestHemusic({
    url: "/v1/user/favourite/playlist",
    method: "post",
    data: { id, platform, name, cover, creator },
  });
};
// 取消收藏歌单
export const unlikePlaylist = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/playlist",
    method: "delete",
    data: { id, platform },
  });
};

// 获取用户收藏专辑
export const userFavouriteAlbum = (page_size: number = 50, page_index: number = 1) => {
  return requestHemusic({
    url: "/v1/user/favourite/albums",
    params: {
      page_index,
      page_size,
    },
  });
};

/**
 * 收藏歌单
 */
export const likeAlbum = (
  id: string,
  platform: string,
  name: string,
  cover: string,
  artists: any[],
) => {
  return requestHemusic({
    url: "/v1/user/favourite/album",
    method: "post",
    data: { id, platform, name, cover, artists },
  });
};
// 取消收藏专辑
export const unlikeAlbum = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/album",
    method: "delete",
    data: { id, platform },
  });
};

// 获取用户收藏歌手
export const userFavouriteArtist = (page_size: number = 50, page_index: number = 1) => {
  return requestHemusic({
    url: "/v1/user/favourite/artists",
    params: {
      page_index,
      page_size,
    },
  });
};

/**
 * 收藏歌单
 */
export const likeArtist = (id: string, platform: string, name: string, cover: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/artist",
    method: "post",
    data: { id, platform, name, cover },
  });
};
// 取消收藏歌单
export const unlikeArtist = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/artist",
    method: "delete",
    data: { id, platform },
  });
};

// 获取用户喜欢的音乐
export const userFavouriteSong = (page_size: number = 50, page_index: number = 1) => {
  return requestHemusic({
    url: "/v1/user/favourite/songs",
    params: { page_size, page_index },
  });
};

/**
 * 收藏歌单
 */
export const likeSong = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/song",
    method: "post",
    data: { id, platform },
  });
};
// 取消收藏歌单
export const unlikeSong = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/user/favourite/song",
    method: "delete",
    data: { id, platform },
  });
};
