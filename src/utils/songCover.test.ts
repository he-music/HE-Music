import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed, reactive } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import { getCoverUrlStr } from "@/api/song";
import { getSizeCover } from "./songCover";

const state = reactive<{ imageSizes: number[]; token: string }>({ imageSizes: [], token: "" });

vi.mock("@/stores/platform", () => ({
  usePlatformStore: () => ({ getPlatformInfo: () => ({ image_sizes: state.imageSizes }) }),
}));
vi.mock("@/stores/data", () => ({ useDataStore: () => state }));
vi.mock("@/api/song", () => ({
  getCoverUrlStr: vi.fn(
    (_platform: string, _id: string, size: number, _redirect: boolean, token: string) =>
      `https://example.com/cover?size=${size}&token=${token}`,
  ),
}));

const song: SongInfo = {
  id: "song-id",
  platform: "test",
  name: "歌曲",
  artists: "歌手",
  album: "专辑",
  subtitle: "",
  duration: 0,
  mv_id: "",
  links: [],
  cover: "https://example.com/{x}/{y}.jpg",
};

beforeEach(() => {
  state.imageSizes = [];
  state.token = "";
  vi.clearAllMocks();
});

describe("歌曲封面地址", () => {
  it("没有歌曲时返回默认封面", () => {
    expect(getSizeCover(null)).toBe("/images/song.jpg?asset");
    expect(getCoverUrlStr).not.toHaveBeenCalled();
  });

  it.each([
    [300, 500],
    [800, 1000],
    [2000, 1000],
    [-1, 1000],
  ])("平台支持尺寸时将 %s 映射为 %s", (requested, expected) => {
    state.imageSizes = [100, 500, 1000];
    expect(getSizeCover(song, requested)).toBe(`https://example.com/${expected}/${expected}.jpg`);
    expect(getCoverUrlStr).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 300],
    [0, 300],
    [-1, 1000],
    [512, 512],
  ])("平台未提供尺寸时使用默认值或请求尺寸 %s", (requested, expected) => {
    expect(getSizeCover(song, requested)).toBe(`https://example.com/${expected}/${expected}.jpg`);
  });

  it("没有封面地址时使用当前 token 构建接口地址", () => {
    state.token = "current-token";
    state.imageSizes = [100, 500];
    getSizeCover({ ...song, cover: "" });
    expect(getCoverUrlStr).toHaveBeenCalledWith("test", "song-id", 500, true, "current-token");
  });

  it("平台尺寸和 token 变化后更新封面地址", () => {
    const cover = computed(() => getSizeCover({ ...song, cover: "" }));
    expect(cover.value).toBe("https://example.com/cover?size=300&token=");
    state.imageSizes = [100, 500];
    expect(cover.value).toBe("https://example.com/cover?size=500&token=");
    state.token = "new-token";
    expect(cover.value).toBe("https://example.com/cover?size=500&token=new-token");
  });
});
