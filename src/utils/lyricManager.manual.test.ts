import { beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SongLyric } from "@/types/lyric";
import { useStatusStore } from "@/stores/status";
import { localEntry } from "@/test/fixtures/localMedia";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { manualLyricKey } from "./manualLyricRecord";
import { manualLyrics } from "./manualLyrics";
import lyricManager from "./lyricManager";

const mocks = vi.hoisted(() => ({
  database: new Map<string, unknown>(),
  save: vi.fn(),
  online: vi.fn(),
  local: vi.fn(),
  entries: [] as ScanEntry[],
  song: {
    id: "shared-id",
    platform: "netease",
    name: "歌名",
    subtitle: "",
    duration: 30,
    mv_id: "",
    album: "",
    links: [],
    cover: "",
  },
  lyrics: { lrcData: [], yrcData: [] } as SongLyric,
}));

vi.mock("@/platform/applicationStorage", () => ({
  manualLyricsDatabase: {},
  createApplicationDatabase: () => ({
    getItem: async (key: string) => mocks.database.get(key),
    setItem: async (key: string, value: unknown) => {
      await mocks.save();
      mocks.database.set(key, structuredClone(value));
    },
    removeItem: async (key: string) => mocks.database.delete(key),
    clear: async () => mocks.database.clear(),
    keys: async () => [...mocks.database.keys()],
  }),
}));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/status")),
  useMusicStore: () => ({
    playSong: mocks.song,
    get songLyric() {
      return mocks.lyrics;
    },
    setSongLyric(data: Partial<SongLyric>) {
      mocks.lyrics = { lrcData: data.lrcData ?? [], yrcData: data.yrcData ?? [] };
    },
  }),
  useSettingStore: () => ({ localLyricPriority: "embedded", showYrc: true }),
}));
vi.mock("@/api/song", () => ({ songLyric: mocks.online }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    value: {
      ready: { value: true },
      get libraryEntries() {
        return mocks.entries;
      },
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: () => mocks.entries[0] }));
vi.mock("@/platform/localResource", () => ({ readLocalLyrics: mocks.local }));

const key = JSON.stringify(["netease", "shared-id"]);
const manual = {
  platform: "kugou",
  id: "candidate-id",
  lyric: "[00:00.00]<0,1000>首句\n[00:20.00]<0,1000>下一句",
  trans: "[00:00.00]translation",
  roma: "[00:00.00]romanization",
};
const load = (download?: ScanEntry) =>
  lyricManager.handleLyric(mocks.song.id, mocks.song.platform, undefined, download);
const lyricText = (index = 0) =>
  mocks.lyrics.lrcData[index]?.words.map((word) => word.word).join("");

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.database.clear();
  mocks.song.platform = "netease";
  mocks.lyrics = { lrcData: [], yrcData: [] };
  mocks.entries = [localEntry()];
  mocks.save.mockReset();
  mocks.local.mockReset().mockResolvedValue("[00:00.00]下载歌词");
  mocks.online.mockReset().mockResolvedValue({ lyric: "[00:00.00]默认歌词" });
});

it("优先读取保存的原始歌词，在暂停位置计算索引，恢复后只读取下载版原歌词", async () => {
  const status = useStatusStore();
  const song = mocks.song;
  status.setSongOffset(song, 620);
  status.currentTime = 20_100;
  await lyricManager.saveManualLyric(key, manual);
  expect(await manualLyrics.get(key)).toEqual(manual);
  await load(mocks.entries[0]);
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.online).not.toHaveBeenCalled();
  expect(status.lyricIndex).toBe(1);
  expect(status.getSongOffset(song)).toBe(0);
  expect(lyricText(status.lyricIndex)).toBe("下一句");
  expect(mocks.lyrics.yrcData[0]).toMatchObject({
    translatedLyric: "translation",
    romanLyric: "romanization",
  });
  status.incSongOffset(song, -500);
  expect(status.getSongOffset(song)).toBe(-500);
  await lyricManager.restoreDefaultLyric(key);
  await load(mocks.entries[0]);
  expect(lyricText()).toBe("下载歌词");
  expect(status.lyricIndex).toBe(0);
  expect(status.getSongOffset(song)).toBe(620);
  expect(status.manualLyricOffsets).toEqual({});
  expect(await manualLyrics.get(key)).toBeNull();
  expect(mocks.online).not.toHaveBeenCalled();
});

it("同 ID 不同音乐平台互不影响；配额失败保留旧选择；全清不改默认偏移", async () => {
  await lyricManager.saveManualLyric(key, manual);
  mocks.save.mockRejectedValueOnce(new Error("QuotaExceededError"));
  await expect(lyricManager.saveManualLyric(key, { ...manual, id: "new" })).rejects.toThrow(
    "Quota",
  );
  expect(await manualLyrics.get(key)).toEqual(manual);
  expect(await manualLyrics.usage()).toEqual({ count: 1, bytes: expect.any(Number) });
  mocks.song.platform = "qq";
  await load();
  expect(lyricText()).toBe("默认歌词");
  expect(mocks.online).toHaveBeenCalledExactlyOnceWith("shared-id", "qq");
  const status = useStatusStore();
  status.currentTimeOffsetMap = { "netease-shared-id": 0.5 };
  status.manualLyricOffsets = { [key]: -0.5 };
  await lyricManager.clearManualLyrics();
  expect(await manualLyrics.usage()).toEqual({ count: 0, bytes: 0 });
  expect(status.manualLyricOffsets).toEqual({});
  expect(status.currentTimeOffsetMap).toEqual({ "netease-shared-id": 0.5 });
});

it("不会把预览空内容写入，也不为真正的本地曲目生成替换键", async () => {
  await expect(
    lyricManager.saveManualLyric(key, { ...manual, lyric: "[00:00.00] " }),
  ).rejects.toThrow();
  expect(await manualLyrics.get(key)).toBeNull();
  expect(manualLyricKey({ ...mocks.song, path: "album/song.mp3" })).toBeNull();
  expect(manualLyricKey({ ...mocks.song, platform: "local" })).toBeNull();
});

it("默认在线词晚到时，不能覆盖同一首歌已经换上的歌词", async () => {
  let resolveOriginal: (value: { lyric: string }) => void = () => {};
  let started: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.online.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      resolveOriginal = resolve;
    });
  });
  const stale = load();
  await requestStarted;
  await lyricManager.saveManualLyric(key, manual);
  await load(mocks.entries[0]);
  resolveOriginal({ lyric: "[00:00.00]迟到的默认歌词" });
  await stale;
  expect(lyricText()).toBe("首句");
  expect(useStatusStore().lyricLoading).toBe(false);
});
