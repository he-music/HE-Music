import { effectScope, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { MVInfo } from "@/types/main.hemusic";
import { useVideoFeed } from "./useVideoFeed";

const video = (id: string): MVInfo => ({
  loading: false,
  id,
  platform: "qq",
  name: id,
  cover: "",
  links: [],
  type: 0,
  play_count: "0",
  creator: "",
  duration: 0,
  description: "",
});
const flush = async () => {
  await nextTick();
  await nextTick();
};

describe("MV 推荐流", () => {
  it("有初始视频且 hasMore 为 false 时仍请求第一页，后续沿用起始 MV", async () => {
    const scope = effectScope();
    const current = ref<MVInfo | null>(video("a"));
    const fetch = vi
      .fn()
      .mockResolvedValue({ list: [video("a"), video("b"), video("b")], has_more: true });
    const feed = scope.run(() => useVideoFeed(ref(true), current, fetch))!;
    await flush();
    expect(fetch).toHaveBeenCalledWith("a", "qq", 1);
    expect(feed.items.value.map((v) => v.id)).toEqual(["a", "b"]);
    current.value = video("b");
    await flush();
    await feed.loadMore();
    expect(fetch).toHaveBeenLastCalledWith("a", "qq", 2);
    scope.stop();
  });

  it("不支持时不请求，能力晚到后自动加载", async () => {
    const scope = effectScope();
    const supported = ref(false);
    const fetch = vi.fn().mockResolvedValue({ list: [], has_more: false });
    const feed = scope.run(() => useVideoFeed(supported, ref(video("a")), fetch))!;
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    supported.value = true;
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    await feed.loadMore();
    expect(fetch).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("失败重试仍使用原页码", async () => {
    const scope = effectScope();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ list: [], has_more: false });
    const feed = scope.run(() => useVideoFeed(ref(true), ref(video("a")), fetch))!;
    await flush();
    expect(feed.failed.value).toBe(true);
    await feed.loadMore();
    expect(fetch).toHaveBeenLastCalledWith("a", "qq", 1);
    expect(feed.failed.value).toBe(false);
    scope.stop();
  });

  it("能力失效后丢弃在途请求结果", async () => {
    const scope = effectScope();
    const supported = ref(true);
    let resolve!: (result: { list: MVInfo[]; has_more: boolean }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ list: MVInfo[]; has_more: boolean }>((r) => {
          resolve = r;
        }),
    );
    const feed = scope.run(() => useVideoFeed(supported, ref(video("a")), fetch))!;
    supported.value = false;
    await flush();
    resolve({ list: [video("b")], has_more: true });
    await flush();
    expect(feed.items.value).toEqual([]);
    expect(feed.loading.value).toBe(false);
    scope.stop();
  });
});
