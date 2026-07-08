import { requestHemusic } from "@/utils/request";

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
  });
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
