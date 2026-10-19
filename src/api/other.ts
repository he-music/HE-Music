import request from "@/utils/request";

interface ReleaseInfo {
  tag_name: string;
  body: string | null;
  published_at: string;
  html_url: string;
  prerelease: boolean;
}

// 获取仓库更新日志
export const updateLog = (): Promise<ReleaseInfo[]> => {
  return request({
    baseURL: "https://api.github.com",
    withCredentials: false,
    url: "/repos/he-music/HE-Music/releases",
    params: { noCookie: true },
  });
};
