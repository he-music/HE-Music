import request, { API_URL, requestHemusic } from "@/utils/request";

// 视频详情
export const videoDetail = (id: string, platform: string) => {
  return requestHemusic({
    url: `/v1/mv`,
    params: { id, platform },
  });
};

// 视频地址
export const videoUrl = (id: number, type: "mv" | "video", r: number) => {
  return request({
    url: `/${type}/url`,
    params: { id, r },
  });
};

// 视频互动数据
export const videoDetailInfo = (id: number, type: "mv" | "video") => {
  return request({
    url: `/${type}/detail/info`,
    params: type === "mv" ? { mvid: id } : { vid: id },
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
 * 全部 mv
 * @param {Area} [area="全部"] - 地区, 可选值为全部, 内地, 港台, 欧美, 日本, 韩国, 默认为全部
 * @param {Type} [type="全部"] - 类型, 可选值为全部, 官方版, 原生, 现场版, 网易出品, 默认为全部
 * @param {Order} [order="上升最快"] - 排序, 可选值为上升最快, 最热, 最新, 默认为上升最快
 * @param {number} [limit=12] - 返回数量，默认12
 * @param {number} [offset=0] - 偏移数量，默认0
 */
export const allMv = (
  area: "全部" | "内地" | "港台" | "欧美" | "日本" | "韩国",
  type: "全部" | "官方版" | "原生" | "现场版" | "网易出品",
  order: "上升最快" | "最热" | "最新",
  limit: number = 12,
  offset: number = 0,
) => {
  return request({
    url: "/mv/all",
    params: { area, type, order, limit, offset },
  });
};

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
