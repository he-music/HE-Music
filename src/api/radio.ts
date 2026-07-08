import { requestHemusic } from "@/utils/request";

/**
 * 获取歌手详情
 * @param platform
 */
export const listRadios = (platform: string) => {
  return requestHemusic({
    url: "/v1/radios",
    params: { platform },
  });
};

export const listRadioSongs = (
  id: string,
  platform: string,
  pageIndex: number = 1,
  pageSize: number = 5,
) => {
  return requestHemusic({
    url: "/v1/radio/songs",
    params: { id, platform, page_index: pageIndex, page_size: pageSize },
  });
};
