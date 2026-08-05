import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendSongListInfo } from "@/types/page";

const { requestHemusicMock } = vi.hoisted(() => ({
  requestHemusicMock: vi.fn(),
}));

vi.mock("@/utils/request", () => ({
  requestHemusic: requestHemusicMock,
}));

import { getRecommendSongList } from "@/api/page";

describe("getRecommendSongList", () => {
  beforeEach(() => {
    requestHemusicMock.mockReset();
  });

  it("直接返回 HTTP 详情对象，不读取 info 包装", async () => {
    const response: RecommendSongListInfo = {
      id: "daily",
      title: "每日推荐",
      cover: "cover.jpg",
      description: "每日精选歌曲",
      songs: [],
    };
    requestHemusicMock.mockResolvedValue(response);

    await expect(getRecommendSongList("qq", "daily")).resolves.toBe(response);
    expect(requestHemusicMock).toHaveBeenCalledWith({
      url: "/v1/page/recommend/song-list",
      params: { platform: "qq", id: "daily" },
    });
  });
});
