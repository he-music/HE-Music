import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { localEntry } from "@/test/fixtures/localMedia";

const mocks = vi.hoisted(() => ({
  song: { id: "online", platform: "test" },
  owner: { ready: { value: true }, libraryEntries: [] as ScanEntry[] },
  read: vi.fn(),
  publish: vi.fn(),
  online: vi.fn(),
  settings: { enableLocalLyricsExclude: false, localLyricPriority: "embedded" },
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => ({
    playSong: mocks.song,
    setSongLyric: mocks.publish,
    songLyric: mocks.publish.mock.lastCall?.[0],
  }),
  useStatusStore: () => ({
    lyricLoading: false,
    lyricIndex: -1,
    currentTime: 0,
    getSongOffset: () => 0,
  }),
  useSettingStore: () => mocks.settings,
}));
vi.mock("@/api/song", () => ({ songLyric: mocks.online }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return mocks.owner;
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: () => undefined }));
vi.mock("@/platform/localResource", () => ({ readLocalLyrics: mocks.read }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.owner.ready.value = true;
  mocks.owner.libraryEntries = [localEntry()];
  mocks.read.mockResolvedValue("[00:00.00]离线歌词");
});
afterEach(() => vi.unstubAllGlobals());

it("已下载文件歌词按原在线歌曲身份发布，无需在线请求", async () => {
  const manager = (await import("./lyricManager")).default;
  await manager.handleLyric("online", "test", undefined, mocks.owner.libraryEntries[0]);
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(mocks.owner.libraryEntries[0], "embedded");
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      lrcData: expect.arrayContaining([
        expect.objectContaining({
          words: expect.arrayContaining([expect.objectContaining({ word: "离线歌词" })]),
        }),
      ]),
    }),
    true,
  );
  expect(mocks.online).not.toHaveBeenCalled();
  expect(mocks.publish).toHaveBeenCalledOnce();
});

it("读取过程中目录失效时丢弃已下载文件歌词", async () => {
  const manager = (await import("./lyricManager")).default;
  const entry = mocks.owner.libraryEntries[0];
  mocks.read.mockImplementationOnce(async () => {
    mocks.owner.libraryEntries = [];
    return "[00:00.00]过期歌词";
  });
  await manager.handleLyric("online", "test", undefined, entry);
  expect(mocks.publish).toHaveBeenLastCalledWith({ lrcData: [], yrcData: [] }, true);
  expect(mocks.online).not.toHaveBeenCalled();
});
