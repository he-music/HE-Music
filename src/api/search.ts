import { requestHemusic } from "@/utils/request";
import type {
  ComprehensiveSearchResponse,
  SearchLyricSongRequest,
  SearchLyricSongResponse,
  SearchSongResponse,
} from "@/types/main.hemusic";

// 热搜
export const searchHot = (platform: string) => {
  return requestHemusic({
    url: "/v1/search/hotkey",
    params: {
      platform: platform,
    },
  });
};

// 搜索建议
export const searchSuggest = (keywords: string, platform: string) => {
  return requestHemusic({
    url: `/v1/search/suggest`,
    params: {
      key: keywords,
      platform: platform,
    },
  });
};

// 默认搜索关键词
export const searchDefault = (platform: string) => {
  return requestHemusic({
    url: "/v1/search/default",
    params: {
      platform,
    },
  });
};

// 综合搜索
export const comprehensiveSearch = (key: string, platform: string) => {
  return requestHemusic({
    url: "/v1/search",
    params: {
      key,
      platform,
    },
  }) as Promise<ComprehensiveSearchResponse>;
};

// 搜索歌曲
export const searchSong = (
  key: string,
  page_size: number = 30,
  page_index: number = 1,
  platform: string,
) => {
  return requestHemusic({
    url: "/v1/song/search",
    params: {
      key,
      page_size,
      page_index,
      platform,
    },
  }) as Promise<SearchSongResponse>;
};

// 根据歌词内容搜索歌曲
export const searchLyricSong = (params: SearchLyricSongRequest) => {
  return requestHemusic({
    url: "/v1/song/lyric/search",
    params,
  }) as Promise<SearchLyricSongResponse>;
};

// 搜索结果
export const searchResultHemusic = (
  key: string,
  page_size: number = 30,
  page_index = 1,
  platform: string,
  type = "song",
) => {
  return requestHemusic({
    url: `/v1/${type}/search`,
    params: {
      key,
      page_size,
      page_index,
      platform,
    },
  });
};
