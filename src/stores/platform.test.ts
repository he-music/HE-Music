import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { platformsMock } = vi.hoisted(() => ({ platformsMock: vi.fn() }));
vi.mock("@/utils/request", () => ({ requestHemusic: platformsMock }));
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "./platform";

const flags = [
  [FeatureSupportFlag.GetSongDetail, 17592186044416],
  [FeatureSupportFlag.ListMVFeeds, 35184372088832],
  [FeatureSupportFlag.GetSearchDefault, 70368744177664],
  [FeatureSupportFlag.FeatureSupportSearchLyricSong, 140737488355328],
  [FeatureSupportFlag.FeatureSupportSearchLyric, 281474976710656],
] as const;
const platformResponse = (feature_support_flag: number) => ({
  list: [
    {
      id: "qq",
      name: "QQ音乐",
      shortname: "QQ",
      order: 0,
      tags: [],
      feature_support_flag,
      status: 1,
      image_sizes: [],
      qualities: [{ name: "320", description: "高品质" }],
    },
  ],
});

beforeEach(() => {
  setActivePinia(createPinia());
  platformsMock.mockReset();
});

describe("平台高位功能标记", () => {
  it.each(flags)("按新协议解析独立功能位 %s（JSON 数值 %s）", async (flag, numericFlag) => {
    expect(flag).toBe(BigInt(numericFlag));
    platformsMock.mockResolvedValue(JSON.parse(JSON.stringify(platformResponse(numericFlag))));
    const store = usePlatformStore();
    await store.loadPlatforms();
    expect(platformsMock).toHaveBeenCalledExactlyOnceWith({ url: "/v1/platforms", params: {} });
    expect(store.getPlatformInfo("qq")?.feature_support_flag).toBe(flag);
    expect(store.isFeatureSupport("qq", flag)).toBe(true);
    expect(store.featureSupportList(flag).map((item) => item.id)).toEqual(["qq"]);
    for (const [otherFlag] of flags) {
      if (otherFlag !== flag) expect(store.isFeatureSupport("qq", otherFlag)).toBe(false);
    }
    // 普通 Number 位运算会将这些高位截断或映射到低位。
    expect(store.isFeatureSupport("qq", 1n << 12n)).toBe(false);
    expect(store.isFeatureSupport("missing", flag)).toBe(false);
  });

  it.each([0, 8796093022208, 123145302310912, 545357767376896])(
    "混合高位和全零功能标记不串位：%s",
    async (numericFlag) => {
      expect(Number.isSafeInteger(numericFlag)).toBe(true);
      platformsMock.mockResolvedValue(platformResponse(numericFlag));
      const store = usePlatformStore();
      await store.loadPlatforms();
      for (const [flag] of flags) {
        const expected = (BigInt(numericFlag) & flag) !== 0n;
        expect(store.isFeatureSupport("qq", flag)).toBe(expected);
        expect(store.featureSupportList(flag)).toHaveLength(expected ? 1 : 0);
      }
    },
  );

  it("平台配置仅在当前实例中复用，新实例重新获取后端标记", async () => {
    platformsMock.mockResolvedValueOnce(platformResponse(35184372088832));
    const store = usePlatformStore();
    await store.loadPlatforms();
    await store.loadPlatforms();
    expect(platformsMock).toHaveBeenCalledTimes(1);
    setActivePinia(createPinia());
    platformsMock.mockResolvedValueOnce(platformResponse(70368744177664));
    const restartedStore = usePlatformStore();
    await restartedStore.loadPlatforms();
    expect(platformsMock).toHaveBeenCalledTimes(2);
    expect(restartedStore.isFeatureSupport("qq", FeatureSupportFlag.ListMVFeeds)).toBe(false);
    expect(restartedStore.isFeatureSupport("qq", FeatureSupportFlag.GetSearchDefault)).toBe(true);
  });
});
