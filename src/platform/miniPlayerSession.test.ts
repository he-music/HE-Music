import { nextTick, reactive } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { createMiniPlayerSession } from "./miniPlayerSession";
import type { MiniPlayerClosed, MiniPlayerCommand, MiniPlayerSnapshot } from "./mygo.bindings";

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((finish) => (resolve = finish));
  return { promise, resolve };
}

function setup() {
  const playback = reactive<MiniPlayerSnapshot>({
    trackKey: "song-a",
    title: "甲",
    artist: "歌手",
    artwork: "",
    language: "zh-CN",
    theme: "system",
    playing: false,
    canPrevious: true,
    canNext: true,
    favorite: false,
    canFavorite: true,
  });
  const clock = reactive({ currentTime: 0 });
  let closed: (event: MiniPlayerClosed) => void = () => {};
  let command: (event: MiniPlayerCommand) => void = () => {};
  const off = vi.fn();
  const provider = {
    open: vi
      .fn<(snapshot: MiniPlayerSnapshot, minimizeMain: boolean) => Promise<number>>()
      .mockResolvedValue(1),
    publish: vi
      .fn<(generation: number, snapshot: MiniPlayerSnapshot) => Promise<void>>()
      .mockResolvedValue(undefined),
    onClosed: (handler: typeof closed) => ((closed = handler), off),
    onCommand: (handler: typeof command) => ((command = handler), off),
  };
  const execute = vi.fn<(value: MiniPlayerCommand) => Promise<void>>().mockResolvedValue(undefined);
  const report = vi.fn();
  const session = createMiniPlayerSession(provider, () => ({ ...playback }), execute, report);
  disposals.push(session.dispose);
  return { session, provider, off, closed, command, playback, clock, execute, report };
}

it("仅在小窗打开时发布歌曲与播放状态，进度不触发更新", async () => {
  const { session, provider, closed, playback, clock } = setup();
  playback.title = "新歌";
  await nextTick();
  expect(provider.publish).not.toHaveBeenCalled();
  await session.open();
  expect(provider.open).toHaveBeenCalledWith(expect.objectContaining({ title: "新歌" }), false);
  provider.publish.mockClear();

  clock.currentTime = 800;
  await nextTick();
  expect(provider.publish).not.toHaveBeenCalled();
  playback.playing = true;
  playback.artist = "新歌手";
  await nextTick();
  expect(provider.publish).toHaveBeenCalledExactlyOnceWith(
    1,
    expect.objectContaining({ playing: true, artist: "新歌手" }),
  );

  closed({ generation: 1, failed: false });
  provider.publish.mockClear();
  playback.title = "切歌";
  await nextTick();
  expect(provider.publish).not.toHaveBeenCalled();
});

it("仅显式开启设置时，才将最小化主窗口的请求交给原生窗口", async () => {
  const { session, provider } = setup();
  await session.open(true);
  expect(provider.open).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ trackKey: "song-a" }),
    true,
  );
});

it("关闭早于打开回执时不恢复旧窗口订阅，重开只接收新窗口操作", async () => {
  const { session, provider, closed, command, execute, report, off } = setup();
  const first = deferred<number>();
  provider.open.mockReturnValueOnce(first.promise).mockResolvedValueOnce(2);
  const opening = session.open();
  expect(session.open()).toBeUndefined();
  closed({ generation: 1, failed: true });
  first.resolve(1);
  await opening;
  expect(report).toHaveBeenCalledOnce();
  expect(provider.publish).not.toHaveBeenCalled();
  await session.open();
  command({ generation: 1, trackKey: "song-a", action: "next", favorite: false });
  command({ generation: 2, trackKey: "song-a", action: "next", favorite: false });
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ generation: 2, action: "next" }),
  );
  session.dispose();
  expect(off).toHaveBeenCalledTimes(2);
  command({ generation: 2, trackKey: "song-a", action: "next", favorite: false });
  expect(execute).toHaveBeenCalledOnce();
});

it("拒绝已经切走的歌和当前不可执行的收藏、切歌命令", async () => {
  const { session, command, playback, execute } = setup();
  await session.open();
  playback.trackKey = "song-b";
  playback.canFavorite = false;
  playback.canPrevious = false;
  command({ generation: 1, trackKey: "song-a", action: "toggle", favorite: false });
  command({ generation: 1, trackKey: "song-b", action: "favorite", favorite: true });
  command({ generation: 1, trackKey: "song-b", action: "previous", favorite: false });
  expect(execute).not.toHaveBeenCalled();
  playback.canFavorite = true;
  command({ generation: 1, trackKey: "song-b", action: "favorite", favorite: false });
  command({ generation: 1, trackKey: "song-b", action: "favorite", favorite: true });
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ trackKey: "song-b", favorite: true }),
  );
});

it("原生回执未返回时只保留最新快照，关闭后不补发旧数据", async () => {
  const { session, provider, closed, playback } = setup();
  const busy = deferred<void>();
  provider.publish.mockReturnValueOnce(busy.promise);
  await session.open();
  playback.title = "中间状态";
  await nextTick();
  playback.title = "最终状态";
  await nextTick();
  expect(provider.publish).toHaveBeenCalledOnce();
  busy.resolve(undefined);
  await vi.waitFor(() => expect(provider.publish).toHaveBeenCalledTimes(2));
  expect(provider.publish).toHaveBeenLastCalledWith(
    1,
    expect.objectContaining({ title: "最终状态" }),
  );
  const next = deferred<void>();
  provider.publish.mockReturnValueOnce(next.promise);
  playback.title = "关闭前";
  await nextTick();
  playback.title = "已排队";
  await nextTick();
  closed({ generation: 1, failed: false });
  next.resolve(undefined);
  await nextTick();
  expect(provider.publish).toHaveBeenCalledTimes(3);
});
