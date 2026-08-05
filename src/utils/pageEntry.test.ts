import { describe, expect, it, vi } from "vitest";
import { FeatureSupportFlag } from "@/api/platform";
import { PageEntryTargetType, type PageEntry } from "@/types/page";
import { resolvePageEntryAction } from "@/utils/pageEntry";

vi.mock("@/utils/request", () => ({
  requestHemusic: vi.fn(),
}));

const entry = (targetType: number): PageEntry => ({
  target_type: targetType,
  target_id: "target-1",
  title: "快捷入口",
});

describe("resolvePageEntryAction", () => {
  it("将推荐歌曲集合分发到详情路由", () => {
    expect(resolvePageEntryAction(entry(PageEntryTargetType.SongList), "qq")).toEqual({
      type: "route",
      routeName: "recommend-song-list",
      query: { platform: "qq", target_id: "target-1" },
    });
  });

  it("将电台分发到电台播放动作", () => {
    expect(resolvePageEntryAction(entry(PageEntryTargetType.Radio), "qq")).toEqual({
      type: "radio",
      id: "target-1",
      platform: "qq",
      title: "快捷入口",
    });
  });

  it("将歌单分发到现有歌单详情路由", () => {
    expect(resolvePageEntryAction(entry(PageEntryTargetType.Playlist), "qq")).toEqual({
      type: "route",
      routeName: "playlist",
      query: { platform: "qq", id: "target-1" },
    });
  });

  it("忽略未知入口类型", () => {
    expect(resolvePageEntryAction(entry(100), "qq")).toBeNull();
  });
});

describe("FeatureSupportFlag", () => {
  it("保留推荐歌曲集合能力位", () => {
    expect(FeatureSupportFlag.FeatureSupportGetRecommendSongList).toBe(1n << 26n);
    expect("GetDailyRecommendSongList" in FeatureSupportFlag).toBe(false);
  });
});
