import { afterEach, expect, it, vi } from "vitest";
import type { SongLyric } from "@/types/lyric";
import type { ScanEntry } from "@/platform/mygo.bindings";

const mocks = vi.hoisted(() => ({
  setSongLyric: vi.fn<(data: Partial<SongLyric>, merge: boolean) => void>(),
  status: { lyricLoading: false, lyricIndex: -1 },
  online: vi.fn(),
  lookup: vi.fn<(songID: string) => ScanEntry | undefined>(),
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => ({
    playSong: { id: "mygo-local:file", platform: "local" },
    setSongLyric: mocks.setSongLyric,
  }),
  useStatusStore: () => mocks.status,
  useSettingStore: () => ({ enableLocalLyricsExclude: false }),
}));
vi.mock("./env", () => ({ isElectron: false }));
vi.mock("@/api/song", () => ({ songLyric: mocks.online }));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: mocks.lookup }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.lookup.mockReset();
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
  mocks.lookup.mockReturnValue(embeddedEntry("[00:00.00]授权中的歌词\n[00:01.00]下一句"));
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
