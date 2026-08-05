import { requestHemusic } from "@/utils/request";
import type {
  DiscoverPageResponse,
  RecommendPageResponse,
  RecommendSongListInfo,
} from "@/types/page";

// 获取推荐页面
export const recommendPage = (platform: string, pageIndex: number) => {
  return requestHemusic({
    url: "/v1/page/recommend",
    params: {
      platform,
      page_index: pageIndex,
    },
  }) as Promise<RecommendPageResponse>;
};

// 获取推荐歌曲集合，HTTP response_body 为 info，响应没有 info 包装。
export const getRecommendSongList = (platform: string, id: string) => {
  return requestHemusic({
    url: "/v1/page/recommend/song-list",
    params: { platform, id },
  }) as Promise<RecommendSongListInfo>;
};

// 获取发现页面
export const discoverPage = (platform: string) => {
  return requestHemusic({
    url: "/v1/page/discover",
    params: {
      platform,
    },
  }) as Promise<DiscoverPageResponse>;
};
