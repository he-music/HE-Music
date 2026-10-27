import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderer, h, nextTick, reactive } from "vue";
import type { LyricsCommand, PlatformDesktopLyrics } from "@/platform/desktopLyrics";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", desktopLyrics: undefined as PlatformDesktopLyrics | undefined },
  music: {} as Record<string, unknown>,
  status: {} as Record<string, unknown>,
  player: {
    getSeek: vi.fn(() => 5432),
    onSeek: vi.fn(() => () => {}),
    playOrPause: vi.fn(),
    nextOrPrev: vi.fn(),
  },
  openSetting: vi.fn(),
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("@/utils/modal", () => ({ openSetting: mocks.openSetting }));
import { createShellDesktopLyricsSession } from "./shellDesktopLyrics";

const flush = async () => {
  await nextTick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
afterEach(() => vi.clearAllMocks());

describe("shellDesktopLyrics", () => {
  it.each(["web", "electron"])("%s保持原路径且不注册新producer", (kind) => {
    mocks.platform.kind = kind;
    expect(createShellDesktopLyricsSession()).toBeUndefined();
    expect(mocks.player.onSeek).not.toHaveBeenCalled();
  });

  it("真实曲目信息/歌词与毫秒单位；高频进度不触发主组件更新，切歌仍更新", async () => {
    mocks.platform.kind = "mygo";
    const publishSnapshot = vi.fn(async () => {});
    const publishClock = vi.fn(async () => {});
    const commands = new Set<(command: LyricsCommand) => void>();
    mocks.platform.desktopLyrics = {
      begin: async () => ({ epoch: 4 }),
      getState: vi.fn(async () => ({
        epoch: 4,
        revision: 1,
        visible: false,
        pending: false,
        locked: false,
        hoverUnlock: false,
        bounds: { x: 0, y: 0, width: 800, height: 180 },
        failure: "",
      })),
      publishSnapshot,
      publishClock,
      teardown: vi.fn(async () => {}),
      onWindow: () => () => {},
      onCommand: (listener) => {
        commands.add(listener);
        return () => {
          commands.delete(listener);
        };
      },
      onSnapshot: vi.fn(),
      onClock: vi.fn(),
      attach: vi.fn(),
      close: vi.fn(),
      command: vi.fn(),
      setVisible: vi.fn(),
      setBounds: vi.fn(),
    };
    mocks.music = reactive({
      playSong: { id: "one", platform: "test", name: "One", artists: [{ name: "Singer" }] },
      songLyric: {
        lrcData: [
          {
            words: [{ startTime: 1, endTime: 2, word: "声", romanWord: "koe" }],
            translatedLyric: "声音",
            romanLyric: "koe",
            isBG: true,
            isDuet: true,
            startTime: 0,
            endTime: 3,
          },
        ],
        yrcData: [],
      },
    });
    mocks.status = reactive({
      playStatus: true,
      playRate: 1.5,
      lyricLoading: false,
      currentTime: 0,
      getSongOffset: () => -175,
    });
    let renders = 0;
    const renderer = createRenderer<object, object>({
      createElement: () => ({}),
      createText: () => ({}),
      createComment: () => ({}),
      insert() {},
      remove() {},
      setText() {},
      setElementText() {},
      patchProp() {},
      parentNode: () => null,
      nextSibling: () => null,
    });
    const session = createShellDesktopLyricsSession()!;
    const app = renderer.createApp({
      setup: () => () => {
        renders++;
        const song = mocks.music.playSong as { name: string };
        return h("div", song.name);
      },
    });
    app.mount({});
    await session.start();
    expect(session.failure.value).toBeUndefined();
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        trackKey: '["test","one"]',
        playName: "One",
        artistName: "Singer",
        positionMs: 5432,
        offsetMs: -175,
        rate: 1.5,
        loading: false,
        lrcData: (mocks.music.songLyric as { lrcData: unknown[] }).lrcData,
      }),
    );
    const initialSnapshots = publishSnapshot.mock.calls.length;
    for (const action of ["toggle", "previous", "next", "open-settings"] as const) {
      commands.forEach((listener) => listener({ epoch: 4, trackKey: '["test","one"]', action }));
    }
    await vi.dynamicImportSettled();
    await flush();
    expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
    expect(mocks.player.nextOrPrev.mock.calls).toEqual([["prev"], ["next"]]);
    expect(mocks.openSetting).toHaveBeenCalledExactlyOnceWith("lyrics", "showDesktopLyric");
    for (let i = 0; i < 50; i++) {
      mocks.status.currentTime = i * 100;
      await session.publishClock();
      await nextTick();
    }
    expect(renders).toBe(1);
    expect(publishSnapshot).toHaveBeenCalledTimes(initialSnapshots);
    mocks.music.playSong = { id: "two", platform: "test", name: "Two", artists: "Other" };
    await flush();
    expect(renders).toBe(2);
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackKey: '["test","two"]', playName: "Two", artistName: "Other" }),
    );
    commands.forEach((listener) =>
      listener({ epoch: 4, trackKey: '["test","one"]', action: "toggle" }),
    );
    await flush();
    expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
    mocks.music.playSong = { id: "three", platform: "test", name: "No artist" };
    await flush();
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackKey: '["test","three"]', artistName: "" }),
    );
    await session.dispose();
    app.unmount();
  });
});
