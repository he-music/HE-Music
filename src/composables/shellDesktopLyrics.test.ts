import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultDesktopLyricStyle } from "@/platform/desktopLyricStyle";
import { createDefaultDesktopLyricOptions } from "@/platform/desktopLyricOptions";
import { createRenderer, h, nextTick, reactive } from "vue";
import type {
  LyricsCommand,
  LyricsSnapshot,
  PlatformDesktopLyrics,
} from "@/platform/desktopLyrics";
import type { SongLyric } from "@/types/lyric";
import { parseLineLyric } from "@/utils/lyric";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", desktopLyrics: undefined as PlatformDesktopLyrics | undefined },
  music: {} as Record<string, unknown>,
  status: {} as Record<string, unknown>,
  setting: {} as Record<string, unknown>,
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
  useSettingStore: () => mocks.setting,
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
    const settings = reactive({
      desktopLyricStyle: createDefaultDesktopLyricStyle(),
      desktopLyricOptions: createDefaultDesktopLyricOptions(),
      unrelated: false,
    });
    mocks.setting = settings;
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
      setLocked: vi.fn(),
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
        style: createDefaultDesktopLyricStyle(),
      }),
    );
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ options: createDefaultDesktopLyricOptions() }),
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
    settings.unrelated = true;
    await flush();
    expect(publishSnapshot).toHaveBeenCalledTimes(initialSnapshots);
    settings.desktopLyricStyle.playedColor = "#123456";
    await flush();
    expect(publishSnapshot).toHaveBeenCalledTimes(initialSnapshots + 1);
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        style: { ...createDefaultDesktopLyricStyle(), playedColor: "#123456" },
      }),
    );
    expect(renders).toBe(1);
    const beforeOptions = publishSnapshot.mock.calls.length;
    settings.desktopLyricOptions.font.size = 48;
    settings.desktopLyricOptions.showTran = false;
    await flush();
    expect(publishSnapshot).toHaveBeenCalledTimes(beforeOptions + 1);
    expect(publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: {
          ...createDefaultDesktopLyricOptions(),
          font: { ...createDefaultDesktopLyricOptions().font, size: 48 },
          showTran: false,
        },
      }),
    );
    expect(renders).toBe(1);
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

  it.each(["lrcData", "yrcData"] as const)(
    "%s 加载完成后能同步开放结束时间，且不修改播放器中的歌词",
    async (lyricKind) => {
      mocks.platform.kind = "mygo";
      mocks.setting = reactive({});
      const songLyric: SongLyric = { lrcData: [], yrcData: [] };
      const music = reactive({
        playSong: {
          id: "mygo-local:file",
          platform: "local",
          name: "本地歌曲",
          artists: "歌手",
        },
        songLyric,
      });
      const status = reactive({
        playStatus: true,
        playRate: 1,
        lyricLoading: true,
        getSongOffset: () => 0,
      });
      mocks.music = music;
      mocks.status = status;
      let received: LyricsSnapshot | undefined;
      const publishSnapshot = vi.fn(async (snapshot: LyricsSnapshot) => {
        // 模拟原生接口对歌词时间的校验，并经 JSON 传输后交给桌面歌词。
        for (const line of [...snapshot.lrcData, ...snapshot.yrcData]) {
          const ranges = [line, ...line.words];
          if (
            ranges.some(
              ({ startTime, endTime }) =>
                !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime,
            )
          ) {
            throw new Error("桌面歌词时间无效");
          }
        }
        received = JSON.parse(JSON.stringify(snapshot));
      });
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
        publishClock: vi.fn(async () => {}),
        teardown: vi.fn(async () => {}),
        onWindow: () => () => {},
        onCommand: () => () => {},
        onSnapshot: vi.fn(),
        onClock: vi.fn(),
        attach: vi.fn(),
        close: vi.fn(),
        command: vi.fn(),
        setVisible: vi.fn(),
        setBounds: vi.fn(),
        setLocked: vi.fn(),
      };
      const session = createShellDesktopLyricsSession()!;
      try {
        await session.start();
        expect(received?.loading).toBe(true);
        const lines = parseLineLyric({
          lyric: "[00:01.00]第一句\n[00:03.00]最后一句",
          trans: "[00:03.00]末句翻译",
          roma: "[00:03.00]roman",
        }).line;
        music.songLyric[lyricKind] = lines;
        status.lyricLoading = false;
        await flush();
        expect(session.failure.value).toBeUndefined();
        expect(received?.loading).toBe(false);
        expect(received?.trackKey).toBe('["local","mygo-local:file"]');
        expect(received?.[lyricKind][0]).toEqual(lines[0]);
        expect(received?.[lyricKind][1]).toEqual({
          ...lines[1],
          endTime: lines[1].startTime,
          words: lines[1].words.map((word) => ({ ...word, endTime: word.startTime })),
        });
        expect(lines[1].endTime).toBe(Infinity);
        expect(lines[1].words[0].endTime).toBe(Infinity);
        await session.publishClock();
        expect(mocks.platform.desktopLyrics.publishClock).toHaveBeenCalledWith(
          expect.objectContaining({ trackKey: '["local","mygo-local:file"]' }),
        );
      } finally {
        await session.dispose();
      }
    },
  );
});
