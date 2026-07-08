import { requestHemusic } from "@/utils/request";

/**
 * 歌手分类列表
 */
export const filterArtists = (
  platform: string = "",
  page_index: number = 0,
  page_size: number = 50,
  filters: Record<string, string> = {},
) => {
  return requestHemusic({
    url: "/v1/artist/filter/artists",
    params: {
      platform,
      page_index,
      page_size,
      filters,
    },
  });
};

/**
 * 筛选歌手
 * @param platform
 */
export const artistFilters = (platform: string) => {
  return requestHemusic({
    url: "/v1/artist/filters",
    params: { platform },
  });
};

/**
 * 获取歌手详情
 * @param  id - 歌手id
 * @param platform
 */
export const artistDetail = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/artist",
    params: { id, platform },
  });
};

/**
 * 获取歌手全部歌曲
 * @param {number} id - 歌手id
 * @param platform
 * @param page_index
 * @param page_size
 */
export const artistAllSongs = (
  id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 50,
) => {
  return requestHemusic({
    url: "/v1/artist/songs",
    params: { id, platform, page_index, page_size },
  });
};

/**
 * 获取歌手专辑
 * @param {number} id - 歌手id
 * @param platform
 * @param page_index
 * @param page_size
 */
export const artistAlbums = (
  id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 50,
) => {
  return requestHemusic({
    url: "/v1/artist/albums",
    params: { id, platform, page_index, page_size },
  });
};

/**
 * 获取歌手视频
 * @param {number} id - 歌手id
 * @param platform
 * @param page_index
 * @param page_size
 */
export const artistVideos = (
  id: string,
  platform: string,
  page_index: number = 1,
  page_size: number = 50,
) => {
  return requestHemusic({
    url: "/v1/artist/mvs",
    params: { id, platform, page_index, page_size },
  });
};

/**
 * 获取歌手写真
 * @param platform 平台
 * @param ids - 歌手id
 * @param names - 歌手名字
 */
export const artistPhotos = (platform: string, ids: string[], names: string[]) => {
  return requestHemusic({
    url: "/v1/artist/photos",
    method: "get",
    params: { platform, ids, names },
  });
};
