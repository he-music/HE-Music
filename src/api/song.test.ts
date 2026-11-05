import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSongDetailResponse } from "@/types/main.hemusic";

const { requestHemusicMock } = vi.hoisted(() => ({ requestHemusicMock: vi.fn() }));
vi.mock("@/utils/request", () => ({
  default: vi.fn(),
  API_URL: "http://localhost",
  requestHemusic: requestHemusicMock,
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));
import { songDetail, songUrl } from "@/api/song";

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

afterEach(() => vi.unstubAllGlobals());

it("网页歌曲地址请求不携带客户端解密参数", async () => {
  vi.stubGlobal("window", {});
  requestHemusicMock.mockClear();
  const response = { url: "https://decrypt.example/audio", format: "flac" };
  requestHemusicMock.mockResolvedValue(response);
  await expect(songUrl("song", "kuwo", 2000, "mflac")).resolves.toBe(response);
  expect(requestHemusicMock).toHaveBeenCalledExactlyOnceWith({
    url: "/v1/song/url",
    params: { id: "song", platform: "kuwo", quality: 2000, format: "mflac" },
  });
});

it.each(["kuwo", "migu", "soda", "qq"])("mygo 的 %s 请求默认开启客户端解密", async (platform) => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:49234/secret" });
  requestHemusicMock.mockClear();
  requestHemusicMock.mockResolvedValue({
    url: "https://cdn.example/audio",
    format: "m4a",
    ...(platform === "qq" ? {} : { audio_params: "prepared_params" }),
  });
  const result = await songUrl("song", platform, 320, "m4a", { skipErrorMessage: true });
  expect(requestHemusicMock).toHaveBeenCalledExactlyOnceWith({
    skipErrorMessage: true,
    url: "/v1/song/url",
    params: {
      id: "song",
      platform,
      quality: 320,
      format: "m4a",
      client_decrypt: true,
      audio_params_version: 1,
    },
  });
  expect(result.url).toContain(platform === "qq" ? "https://cdn.example" : "/secret/__audio?");
});
