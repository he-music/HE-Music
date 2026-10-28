import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSongLyric: vi.fn(),
  status: { lyricLoading: false, lyricIndex: -1 },
  online: vi.fn(),
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
