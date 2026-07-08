import { requestHemusic } from "@/utils/request";

// 获取歌单详情
export const playlistDetail = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/playlist",
    params: {
      id,
      platform,
    },
  });
};

export const playlistSongs = (
  id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 1000,
) => {
  return requestHemusic({
    url: `/v1/playlist/songs`,
    params: {
      id,
      platform,
      page_index,
      page_size,
    },
  });
};

// 获取歌单分类信息
export const playlistCategories = (platform: string) => {
  return requestHemusic({
    url: `/v1/playlist/categories`,
    params: {
      platform,
    },
  });
};

// 获取歌单分类信息
export const categoryPlaylists = (
  category_id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 30,
  last_id: string = "",
) => {
  return requestHemusic({
    url: `/v1/category/playlists`,
    params: {
      platform,
      category_id,
      page_index,
      page_size,
      last_id,
    },
  });
};

/**
 * 获取排行榜数据
 * @param platform
 */
export const listRankings = (platform: string) => {
  return requestHemusic({ url: "/v1/rankings", params: { platform } });
};

/**
 * 获取排行榜数据
 * @param platform
 * @param id
 * @param page_index
 * @param page_size
 * @param last_id
 */
export const getRanking = (
  id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 100,
  last_id: string = "",
) => {
  return requestHemusic({
    url: "/v1/ranking",
    params: {
      platform,
      id,
      page_index,
      page_size,
      last_id,
    },
  });
};
