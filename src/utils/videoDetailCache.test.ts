import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoDetailCache } from "./videoDetailCache";
import type { MVInfo } from "@/types/main.hemusic";

const video: MVInfo = {
  id: "a",
  platform: "test",
  name: "A",
  links: [],
  cover: "",
  type: 0,
  play_count: "0",
  creator: "",
  duration: 1,
  description: "",
  loading: false,
};
afterEach(() => vi.useRealTimers());
describe("视频详情预取", () => {
  it("预取和正式播放复用在途请求", async () => {
    const fetch = vi.fn().mockResolvedValue(video);
    const cache = createVideoDetailCache(fetch);
    const prefetch = cache.get("a", "test");
    expect(cache.get("a", "test")).toBe(prefetch);
    expect(await prefetch).toBe(video);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("过期签名、失败请求和主动清理后重新请求", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(video);
    const cache = createVideoDetailCache(fetch);
    await expect(cache.get("a", "test")).rejects.toThrow("offline");
    await cache.get("a", "test");
    vi.advanceTimersByTime(60_001);
    await cache.get("a", "test");
    cache.clear();
    await cache.get("a", "test");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("缓存最多保留三个详情并区分平台", async () => {
    const fetch = vi.fn().mockResolvedValue(video);
    const cache = createVideoDetailCache(fetch);
    await cache.get("a", "test");
    await cache.get("a", "other");
    await cache.get("b", "test");
    await cache.get("c", "test");
    await cache.get("a", "test");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
