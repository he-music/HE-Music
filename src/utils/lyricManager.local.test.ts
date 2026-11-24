import { afterEach, expect, it, vi } from "vitest";
import type { SongLyric } from "@/types/lyric";
import type { ScanEntry } from "@/platform/mygo.bindings";
import type { LocalLyricSource } from "@/platform/localResource";

const mocks = vi.hoisted(() => {
  const read = vi.fn<(entry: ScanEntry, source: LocalLyricSource) => Promise<string>>();
  const createSource = () => ({ ready: { value: true } });
  return {
    read,
    settings: { enableLocalLyricsExclude: false, localLyricPriority: "sidecar" },
    createSource,
    source: { value: createSource() },
    setSongLyric: vi.fn<(data: Partial<SongLyric>, merge: boolean) => void>(),
    status: { lyricLoading: false, lyricIndex: -1, currentTime: 1200, getSongOffset: () => 0 },
    online: vi.fn(),
    lookup: vi.fn<(songID: string) => ScanEntry | undefined>(),
  };
});
vi.mock("@/stores", () => ({
  useMusicStore: () => ({
    playSong: { id: "mygo-local:file", platform: "local" },
    setSongLyric: mocks.setSongLyric,
    songLyric: mocks.setSongLyric.mock.lastCall?.[0],
  }),
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.settings,
}));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("@/api/song", () => ({ songLyric: mocks.online }));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: mocks.lookup }));
vi.mock("@/platform/filesSession", () => ({ filesSession: mocks.source }));
vi.mock("@/platform/localResource", () => ({ readLocalLyrics: mocks.read }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.lookup.mockReset();
  mocks.read.mockReset();
  mocks.source.value = mocks.createSource();
  mocks.settings.localLyricPriority = "sidecar";
});

it("mygo local lyrics clear the current view without reading Electron or requesting an online song", async () => {
  let bridgeReads = 0;
  vi.stubGlobal(
    "window",
    Object.defineProperty({}, "electron", {
      get() {
        bridgeReads++;
        throw new Error("Electron bridge must not be read");
      },
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  const lyricManager = (await import("./lyricManager")).default;
  await lyricManager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  expect(bridgeReads).toBe(0);
  expect(mocks.online).not.toHaveBeenCalled();
  expect(mocks.setSongLyric).toHaveBeenCalledWith({ lrcData: [], yrcData: [] }, true);
  expect(mocks.status.lyricLoading).toBe(false);
});

const embeddedEntry = (lyrics: string): ScanEntry => ({
  ref: { grantToken: "grant", relativePath: "album/song.mp3", fileId: "file", version: "version" },
  relativePath: "album/song.mp3",
  filename: "song.mp3",
  size: 20,
  metadata: {
    Container: "MP3",
    Title: "歌曲",
    Artists: [],
    Album: "",
    AlbumArtists: [],
    Comment: "",
    Lyrics: lyrics,
    Pictures: [],
    PicturesLoaded: false,
    DurationSeconds: 1,
    BitrateKbps: 128,
    SampleRateHz: 44100,
    Channels: 2,
    BitsPerSample: 0,
    Codec: "MPEG",
  },
});

it("parses embedded lyrics from the current native registry and does not reuse a removed entry", async () => {
  const bridge = vi.fn(() => {
    throw new Error("Electron bridge must not be read");
  });
  vi.stubGlobal("window", Object.defineProperty({}, "electron", { get: bridge }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const lyricManager = (await import("./lyricManager")).default;
  const entry = embeddedEntry("[00:00.00]授权中的歌词\n[00:01.00]下一句");
  mocks.lookup.mockReturnValue(entry);
  mocks.read.mockResolvedValue(entry.metadata.Lyrics);
  await lyricManager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  const data = mocks.setSongLyric.mock.calls.at(-1)?.[0];
  expect(
    data?.lrcData?.some((line) => line.words.map((word) => word.word).join("") === "授权中的歌词"),
  ).toBe(true);
  expect(bridge).not.toHaveBeenCalled();
  expect(mocks.online).not.toHaveBeenCalled();
  mocks.lookup.mockReturnValue(undefined);
  await lyricManager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  expect(mocks.setSongLyric).toHaveBeenLastCalledWith({ lrcData: [], yrcData: [] }, true);
});

it("refuses embedded lyrics from a different relative path", async () => {
  const bridge = vi.fn(() => {
    throw new Error("Electron bridge must not be read");
  });
  vi.stubGlobal("window", Object.defineProperty({}, "electron", { get: bridge }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.lookup.mockReturnValue(embeddedEntry("[00:00.00]另一条路径的歌词"));
  const lyricManager = (await import("./lyricManager")).default;
  await lyricManager.handleLyric("mygo-local:file", "local", "other/song.mp3");
  expect(mocks.setSongLyric).toHaveBeenLastCalledWith({ lrcData: [], yrcData: [] }, true);
  expect(bridge).not.toHaveBeenCalled();
  expect(mocks.online).not.toHaveBeenCalled();
});

it("reads full embedded lyrics instead of the bounded 1024-byte scan preview", async () => {
  vi.stubGlobal("window", {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const full = "[00:00.00]" + "长歌词".repeat(400) + "\n[02:00.00]完整歌词末句";
  const entry = embeddedEntry(full.slice(0, 300));
  mocks.lookup.mockReturnValue(entry);
  mocks.read.mockResolvedValue(full);
  const lyricManager = (await import("./lyricManager")).default;
  await lyricManager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  const data = mocks.setSongLyric.mock.calls.at(-1)?.[0];
  expect(
    data?.lrcData?.some((line) => line.words.map((word) => word.word).join("") === "完整歌词末句"),
  ).toBe(true);
  expect(mocks.read).toHaveBeenCalledWith(entry, "sidecar");
  expect(vi.mocked(console.log).mock.calls.length).toBe(0);
});

it.each(["removed", "version", "owner"])(
  "discards full metadata lyrics after %s changes",
  async (change) => {
    vi.stubGlobal("window", {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const entry = embeddedEntry("[00:00.00]扫描预览");
    mocks.lookup.mockReturnValue(entry);
    mocks.read.mockImplementationOnce(async () => {
      if (change === "removed") mocks.lookup.mockReturnValue(undefined);
      if (change === "version")
        mocks.lookup.mockReturnValue({ ...entry, ref: { ...entry.ref, version: "new" } });
      if (change === "owner") mocks.source.value = mocks.createSource();
      return "[00:00.00]失效歌词";
    });
    const lyricManager = (await import("./lyricManager")).default;
    await lyricManager.handleLyric("mygo-local:file", "local", "album/song.mp3");
    expect(mocks.setSongLyric).toHaveBeenLastCalledWith({ lrcData: [], yrcData: [] }, true);
    expect(mocks.read).toHaveBeenCalledOnce();
  },
);

it("快速切换优先级时忽略迟到的歌词", async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const entry = embeddedEntry("");
  mocks.lookup.mockReturnValue(entry);
  mocks.read.mockReturnValueOnce(pending).mockResolvedValueOnce("[00:00.00]新优先级的歌词");
  const manager = (await import("./lyricManager")).default;
  const previous = manager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  mocks.settings.localLyricPriority = "embedded";
  await manager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  finish("[00:00.00]迟到的歌词");
  await previous;
  expect(mocks.setSongLyric).toHaveBeenCalledOnce();
  expect(mocks.setSongLyric.mock.lastCall?.[0].lrcData?.[0].words[0].word).toBe("新优先级的歌词");
});

it.each([
  {
    priority: "sidecar",
    first: "[00:00.00]外部歌词\n[00:01.00]第二句",
    fallback: "embedded",
    want: "外部歌词",
  },
  {
    priority: "embedded",
    first: "[00:00.00]内嵌歌词\n[00:01.00]第二句",
    fallback: "sidecar",
    want: "内嵌歌词",
  },
  { priority: "sidecar", first: "[ar:无时间轴]", fallback: "embedded", want: "备用歌词" },
  { priority: "embedded", first: "", fallback: "sidecar", want: "备用歌词" },
])("$priority 优先，缺少可用歌词时回退（$want）", async ({ priority, first, fallback, want }) => {
  mocks.settings.localLyricPriority = priority;
  const entry = embeddedEntry("");
  mocks.lookup.mockReturnValue(entry);
  mocks.read.mockResolvedValueOnce(first).mockResolvedValueOnce("[00:01.00]备用歌词");
  const manager = (await import("./lyricManager")).default;
  await manager.handleLyric("mygo-local:file", "local", "album/song.mp3");
  expect(mocks.read).toHaveBeenNthCalledWith(1, entry, priority);
  expect(mocks.setSongLyric.mock.lastCall?.[0].lrcData?.[0].words[0].word).toBe(want);
  if (want === "备用歌词") {
    expect(mocks.read).toHaveBeenNthCalledWith(2, entry, fallback);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.status.lyricIndex).toBe(0);
  } else {
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.status.lyricIndex).toBe(1);
  }
});
