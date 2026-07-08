import { requestHemusic } from "@/utils/request";

// 获取专辑详情
export const albumDetail = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/album",
    params: {
      id,
      platform,
    },
  });
};

export const newAlbumTabs = (platform: string) => {
  return requestHemusic({
    url: "/v1/album/new/tabs",
    params: { platform },
  });
};
export const newAlbums = (
  platform: string,
  tab_id: string,
  page_index = 1,
  page_size: number = 30,
) => {
  return requestHemusic({
    url: "/v1/album/tab/news",
    params: { platform, tab_id, page_size, page_index },
  });
};
