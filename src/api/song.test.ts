import { describe, expect, it, vi } from "vitest";
import type { GetSongDetailResponse } from "@/types/main.hemusic";

const { requestHemusicMock } = vi.hoisted(() => ({ requestHemusicMock: vi.fn() }));
vi.mock("@/utils/request", () => ({
  default: vi.fn(),
  API_URL: "http://localhost",
  requestHemusic: requestHemusicMock,
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));
import { songDetail } from "@/api/song";

describe("songDetail", () => {
  it("仅请求详情接口，直接返回同级的 song、fields 和 sections", async () => {
    const response: GetSongDetailResponse = {
      song: {
        id: "song-id",
        platform: "qq",
        name: "歌曲名",
        subtitle: "",
        duration: 180,
        mv_id: "",
        album: "",
        cover: "",
        links: [],
      },
      fields: [{ label: "发行时间", value: "2024-01-01" }],
      sections: [{ resource_type: "song", title: "其他版本", songs: [] }],
    };
    requestHemusicMock.mockResolvedValue(response);
    await expect(songDetail("song-id", "qq")).resolves.toBe(response);
    expect(requestHemusicMock).toHaveBeenCalledExactlyOnceWith({
      url: "/v1/song/detail",
      params: { id: "song-id", platform: "qq" },
    });
  });
});
