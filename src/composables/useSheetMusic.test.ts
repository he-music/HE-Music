import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetMusicInfo } from "@/types/main.hemusic";

const { listMock, detailMock } = vi.hoisted(() => ({ listMock: vi.fn(), detailMock: vi.fn() }));
vi.mock("@/api/sheetMusic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/sheetMusic")>()),
  listSongSheetMusic: listMock,
  getSheetMusic: detailMock,
}));
vi.mock("@/utils/request", () => ({ requestHemusic: vi.fn() }));
import { useSheetMusicDetail, useSheetMusicList } from "./useSheetMusic";

const scopes: ReturnType<typeof effectScope>[] = [];
const context = (active = true) => {
  const scope = effectScope();
  scopes.push(scope);
  return {
    scope,
    platform: ref("qq"),
    songId: ref("0009007199254740993"),
    id: ref("00042"),
    enabled: ref(active),
  };
};
const setupList = (active = true) => {
  const refs = context(active);
  const state = refs.scope.run(() => useSheetMusicList(refs.platform, refs.songId, refs.enabled))!;
  return { ...refs, ...state };
};
const setupDetail = (active = true) => {
  const refs = context(active);
  const state = refs.scope.run(() =>
    useSheetMusicDetail(refs.platform, refs.songId, refs.id, refs.enabled),
  )!;
  return { ...refs, ...state };
};
const flush = async () => {
  await nextTick();
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
const deferred = () => {
  let resolve!: (value: SheetMusicInfo) => void;
  const promise = new Promise<SheetMusicInfo>((done) => (resolve = done));
  return { resolve, promise };
};
const notImplemented = { isAxiosError: true, response: { status: 501 } };

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ list: [{ id: "00042", title: "吉他谱" }] });
  detailMock.mockReset().mockResolvedValue({ id: "00042" });
});
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

describe("曲谱列表页面状态", () => {
  it("列表只加载歌曲曲谱，不请求详情", async () => {
    const state = setupList();
    expect(state.loading.value).toBe(true);
    await flush();
    expect(listMock).toHaveBeenCalledExactlyOnceWith("qq", "0009007199254740993");
    expect(state.sheets.value).toEqual([{ id: "00042", title: "吉他谱" }]);
    expect(detailMock).not.toHaveBeenCalled();
  });

  it.each([{}, { list: null }, { list: [] }])("兼容空列表或缺失 list：%j", async (response) => {
    listMock.mockResolvedValue(response);
    const state = setupList();
    await flush();
    expect(state.sheets.value).toEqual([]);
    expect(state.failed.value).toBe(false);
    expect(state.notImplemented.value).toBe(false);
  });

  it("平台配置未加载、无功能位或离开路由时不请求，启用后加载", async () => {
    const state = setupList(false);
    await flush();
    expect(listMock).not.toHaveBeenCalled();
    state.enabled.value = true;
    await flush();
    expect(listMock).toHaveBeenCalledOnce();
    state.enabled.value = false;
    state.songId.value = "another-song";
    await flush();
    expect(listMock).toHaveBeenCalledOnce();
  });

  it("歌曲或平台路由参数变化后重新请求", async () => {
    const state = setupList();
    await flush();
    state.platform.value = "netease";
    state.songId.value = "000123";
    await flush();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith("netease", "000123");
  });

  it("NotImplemented 与空列表区分，并能重试恢复", async () => {
    listMock.mockRejectedValueOnce(notImplemented);
    const state = setupList();
    await flush();
    expect(state.notImplemented.value).toBe(true);
    expect(state.failed.value).toBe(false);
    await state.retry();
    expect(state.notImplemented.value).toBe(false);
    expect(state.sheets.value).toHaveLength(1);
  });

  it("普通失败后可重试", async () => {
    listMock.mockRejectedValueOnce(new Error("Network Error"));
    const state = setupList();
    await flush();
    expect(state.failed.value).toBe(true);
    await state.retry();
    expect(state.failed.value).toBe(false);
    expect(state.sheets.value).toHaveLength(1);
  });
});

describe("曲谱详情页面状态", () => {
  it("可独立加载详情，无需先获取列表；保持字符串 ID 与页面顺序", async () => {
    detailMock.mockResolvedValue({ id: "00042", page_urls: ["page-2", "page-1", "page-3"] });
    const state = setupDetail();
    expect(state.loading.value).toBe(true);
    await flush();
    expect(detailMock).toHaveBeenCalledExactlyOnceWith("qq", "00042", "0009007199254740993");
    expect(listMock).not.toHaveBeenCalled();
    expect(state.pages.value).toEqual(["page-2", "page-1", "page-3"]);
  });

  it("无详情功能位时不请求，功能位就绪后自动加载", async () => {
    const state = setupDetail(false);
    await flush();
    expect(detailMock).not.toHaveBeenCalled();
    state.enabled.value = true;
    await flush();
    expect(detailMock).toHaveBeenCalledOnce();
  });

  it.each([undefined, [], ["", " "]])(
    "缺少页面时不由 cover/page_count 推导地址：%j",
    async (page_urls) => {
      detailMock.mockResolvedValue({ id: "00042", cover: "cover", page_count: 3, page_urls });
      const state = setupDetail();
      await flush();
      expect(state.pages.value).toEqual([]);
      expect(state.failed.value).toBe(false);
    },
  );

  it("详情 NotImplemented 与普通失败均可重试", async () => {
    detailMock
      .mockRejectedValueOnce(notImplemented)
      .mockRejectedValueOnce(new Error("Network Error"));
    const state = setupDetail();
    await flush();
    expect(state.notImplemented.value).toBe(true);
    expect(state.failed.value).toBe(false);
    await state.retry();
    expect(state.notImplemented.value).toBe(false);
    expect(state.failed.value).toBe(true);
    await state.retry();
    expect(state.failed.value).toBe(false);
    expect(state.info.value?.id).toBe("00042");
  });

  it("详情路由参数变化后忽略旧请求", async () => {
    const older = deferred();
    const newer = deferred();
    detailMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const state = setupDetail();
    state.id.value = "00043";
    state.platform.value = "netease";
    state.songId.value = "000123";
    await flush();
    expect(detailMock).toHaveBeenLastCalledWith("netease", "00043", "000123");
    newer.resolve({ id: "00043", page_urls: ["new-page"] });
    await flush();
    older.resolve({ id: "00042", page_urls: ["old-page"] });
    await flush();
    expect(state.info.value?.id).toBe("00043");
    expect(state.pages.value).toEqual(["new-page"]);
  });

  it("离开路由后忽略在途响应，重新进入时加载当前曲谱", async () => {
    const pending = deferred();
    detailMock.mockReturnValueOnce(pending.promise);
    const state = setupDetail();
    state.enabled.value = false;
    await flush();
    pending.resolve({ id: "00042", page_urls: ["stale"] });
    await flush();
    expect(state.info.value).toBeNull();
    state.enabled.value = true;
    await flush();
    expect(detailMock).toHaveBeenCalledTimes(2);
    expect(state.info.value?.id).toBe("00042");
  });

  it("页面销毁后不接受在途响应", async () => {
    const pending = deferred();
    detailMock.mockReturnValueOnce(pending.promise);
    const state = setupDetail();
    state.scope.stop();
    pending.resolve({ id: "00042" });
    await flush();
    expect(state.info.value).toBeNull();
  });
});
