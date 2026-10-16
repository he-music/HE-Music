import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetMusicInfo } from "@/types/main.hemusic";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@/utils/request", () => ({ requestHemusic: requestMock }));
import { getSheetMusic, isSheetMusicNotImplemented, listSongSheetMusic } from "./sheetMusic";

beforeEach(() => requestMock.mockReset());

describe("曲谱接口协议", () => {
  it("列表只传 platform 和字符串 song_id，不分页", async () => {
    const response = { list: [{ id: "0009007199254740993" }] };
    requestMock.mockResolvedValue(response);
    expect(await listSongSheetMusic("qq", "0009007199254740994")).toBe(response);
    expect(requestMock).toHaveBeenCalledExactlyOnceWith({
      method: "GET",
      url: "/v1/song/sheet-music",
      params: { platform: "qq", song_id: "0009007199254740994" },
      skipErrorMessage: true,
    });
  });

  it("详情传 id 和原歌曲 song_id，直接返回对象", async () => {
    const response: SheetMusicInfo = {
      id: "0009007199254740993",
      song_name: "测试歌曲",
      uploader: "测试上传者",
      page_urls: ["page-2", "page-1"],
    };
    requestMock.mockResolvedValue(response);
    expect(await getSheetMusic("netease", response.id, "000123")).toBe(response);
    expect(requestMock).toHaveBeenCalledExactlyOnceWith({
      method: "GET",
      url: "/v1/sheet-music",
      params: { platform: "netease", id: response.id, song_id: "000123" },
      skipErrorMessage: true,
    });
  });

  it.each([
    { status: 501, data: {} },
    { status: 500, data: { reason: "NotImplemented" } },
    { status: 500, data: { code: "NOT_IMPLEMENTED" } },
    { status: 500, data: { message: "not implemented" } },
  ])("识别尚未开放状态 %j", (response) => {
    expect(isSheetMusicNotImplemented({ isAxiosError: true, response })).toBe(true);
  });

  it.each([
    new Error("Network Error"),
    { isAxiosError: true, response: { status: 500, data: { reason: "INTERNAL_ERROR" } } },
    { isAxiosError: true, response: { status: 403, data: { message: "Forbidden" } } },
  ])("其他失败保持请求失败语义", (error) => {
    expect(isSheetMusicNotImplemented(error)).toBe(false);
  });
});
