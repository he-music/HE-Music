import { requestHemusic } from "@/utils/request";

// 获取发现页面
export const discoverPage = (platform: string) => {
  return requestHemusic({
    url: "/v1/page/discover",
    params: {
      platform,
    },
  });
};
