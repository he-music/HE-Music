import { requestHemusic } from "@/utils/request";
import type { DiscoverPageResponse, RecommendPageResponse } from "@/types/page";

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

// 获取发现页面
export const discoverPage = (platform: string) => {
  return requestHemusic({
    url: "/v1/page/discover",
    params: {
      platform,
    },
  }) as Promise<DiscoverPageResponse>;
};
