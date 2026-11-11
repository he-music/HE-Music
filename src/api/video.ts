import { API_URL, requestHemusic } from "@/utils/request";

// 视频详情
export const videoDetail = (id: string, platform: string) => {
  return requestHemusic({
    url: `/v1/mv`,
    params: { id, platform },
  });
};

// MV 推荐流
export const mvFeeds = (id: string, platform: string, pageIndex: number) => {
  return requestHemusic({
    url: "/v1/mv/feeds",
    params: { id, platform, page_index: pageIndex },
  });
};

export const getMVUrlStr = (
  platform,
  id: string,
  quality = 320,
  format = "mp4",
  redirect = true,
  token = "",
) =>
  `${API_URL}/v1/mv/url?${new URLSearchParams({
    id,
    platform,
    quality: quality.toString(),
    format,
    redirect: redirect.toString(),
    token,
  }).toString()}`;

/**
 * mv分类
 */
export const filterMVs = (
  platform: string = "",
  page_index: number = 0,
  page_size: number = 50,
  filters: Record<string, string> = {},
) => {
  return requestHemusic({
    url: "/v1/mv/filter/mvs",
    params: {
      platform,
      page_index,
      page_size,
      filters,
    },
  });
};

/**
 * 筛选mv
 * @param platform
 */
export const mvFilters = (platform: string) => {
  return requestHemusic({
    url: "/v1/mv/filters",
    params: { platform },
  });
};
