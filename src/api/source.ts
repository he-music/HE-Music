import { requestHemusic } from "@/utils/request";

// 解析来源链接
export const parseSourceUrl = (url: string) => {
  return requestHemusic({
    url: "/v1/source/url/parse",
    method: "post",
    data: { url },
  });
};

// 解析来源链接
export const buildSourceUrl = (platform, id, type: string) => {
  return requestHemusic({
    url: "/v1/source/url/build",
    method: "post",
    data: { platform, id, type },
  });
};
