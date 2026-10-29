import request from "@/utils/request";
import { gatewayProxyUrl, mygoGatewayOrigin } from "@/platform/gateway";

interface ReleaseInfo {
  tag_name: string;
  body: string | null;
  published_at: string;
  html_url: string;
  prerelease: boolean;
}

// 获取仓库更新日志
export const updateLog = async (): Promise<ReleaseInfo[]> => {
  if (mygoGatewayOrigin()) {
    const response = await fetch(
      gatewayProxyUrl("https://api.github.com/repos/he-music/HE-Music/releases?noCookie=true"),
      { credentials: "omit" },
    );
    if (!response.ok) throw new Error("Could not load release notes");
    return response.json();
  }
  return request({
    baseURL: "https://api.github.com",
    withCredentials: false,
    url: "/repos/he-music/HE-Music/releases",
    params: { noCookie: true },
  });
};
