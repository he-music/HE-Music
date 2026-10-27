import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, reactive } from "vue";
import { DesktopLyricsSession, desktopLyricsSession } from "./desktopLyricsSession";
import type { LyricsCommand, LyricsWindowState, PlatformDesktopLyrics } from "./desktopLyrics";

const flush = async () => {
  await nextTick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const state = (revision: number, patch: Partial<LyricsWindowState> = {}): LyricsWindowState => ({
  epoch: 7,
  revision,
  visible: false,
  pending: false,
  locked: false,
  hoverUnlock: false,
  bounds: { x: 0, y: 0, width: 800, height: 180 },
  failure: "",
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const windows = new Set<(value: LyricsWindowState) => void>();
  const commands = new Set<(value: LyricsCommand) => void>();
  const seeks = new Set<() => void>();
  const order: string[] = [];
  const data = reactive({
    track: "a",
    name: "A",
    playing: false,
    rate: 1,
    offset: -175,
    position: 1250,
  });
  const provider: PlatformDesktopLyrics = {
    begin: vi.fn(async () => {
      order.push("begin");
      return { epoch: 7 };
    }),
    publishSnapshot: vi.fn(async () => {
      order.push("snapshot");
    }),
    publishClock: vi.fn(async () => {}),
    setVisible: vi.fn(async () => {
      order.push("show");
      return state(2, { pending: true });
    }),
    getState: vi.fn(async () => state(1)),
    teardown: vi.fn(async () => {}),
    attach: vi.fn(),
    close: vi.fn(),
    setBounds: vi.fn(),
    command: vi.fn(),
    onWindow: (listener) => {
      order.push("window");
      windows.add(listener);
      return () => {
        windows.delete(listener);
      };
    },
    onCommand: (listener) => {
      order.push("command");
      commands.add(listener);
      return () => {
        commands.delete(listener);
      };
    },
    onSnapshot: vi.fn(),
    onClock: vi.fn(),
  };
  const clock = () => ({
    trackKey: data.track,
    playing: data.playing,
    positionMs: data.position,
    offsetMs: data.offset,
    rate: data.rate,
  });
  const snapshot = vi.fn(() => ({
    ...clock(),
    playName: data.name,
    artistName: "Artist",
    loading: false,
    lrcData: [],
    yrcData: [],
  }));
  const execute = vi.fn();
  const session = new DesktopLyricsSession(provider, {
    trackKey: () => data.track,
    snapshotDependencies: () => [data.track, data.name],
    clockDependencies: () => [data.playing, data.rate, data.offset],
    snapshot,
    clock,
    onSeek: (listener) => {
      seeks.add(listener);
      return () => {
        seeks.delete(listener);
      };
    },
    execute,
  });
  return { session, provider, data, order, snapshot, execute, windows, commands, seeks };
}
afterEach(() => vi.useRealTimers());

describe("DesktopLyricsSession", () => {
  it("订阅注册失败退订已安装监听，不调用Begin或向主壳抛错", async () => {
    const f = fixture();
    vi.spyOn(f.provider, "onCommand").mockImplementationOnce(() => {
      throw new Error("synthetic subscription failure");
    });
    await expect(f.session.start()).resolves.toBeUndefined();
    expect(f.provider.begin).not.toHaveBeenCalled();
    expect(f.windows.size).toBe(0);
    expect(f.session.ready.value).toBe(false);
    expect(f.session.failure.value).toBeInstanceOf(Error);
    await f.session.dispose();
  });

  it("初始化快照失败撤销对应epoch并停止watch、订阅和seek监听", async () => {
    const f = fixture();
    vi.mocked(f.provider.publishSnapshot).mockRejectedValueOnce(
      new Error("synthetic delivery failure"),
    );
    await expect(f.session.start()).resolves.toBeUndefined();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.session.ready.value).toBe(false);
    expect(f.session.failure.value).toBeInstanceOf(Error);
    expect(f.windows.size + f.commands.size + f.seeks.size).toBe(0);
    expect(desktopLyricsSession.value).not.toBe(f.session);
    const count = vi.mocked(f.provider.publishSnapshot).mock.calls.length;
    f.data.name = "After failure";
    f.data.playing = true;
    await flush();
    expect(f.provider.publishSnapshot).toHaveBeenCalledTimes(count);
    expect(f.provider.publishClock).not.toHaveBeenCalled();
    await f.session.dispose();
    expect(f.provider.teardown).toHaveBeenCalledOnce();
  });

  it("订阅先于Begin；显示前真实快照；pending不是visible；seq共享且毫秒不重复换算", async () => {
    const f = fixture();
    await expect(f.session.requestVisible(true)).rejects.toThrow("未就绪");
    await f.session.start();
    expect(f.order).toEqual(["window", "command", "begin", "snapshot"]);
    expect(desktopLyricsSession.value).toBe(f.session);
    f.data.position = 5000;
    const pending = await f.session.requestVisible(true);
    expect(pending.pending).toBe(true);
    expect(f.session.window.value?.visible).toBe(false);
    expect(f.order.slice(-2)).toEqual(["snapshot", "show"]);
    f.data.playing = true;
    await flush();
    expect(vi.mocked(f.provider.publishSnapshot).mock.calls[1][0]).toMatchObject({
      epoch: 7,
      seq: 2,
      positionMs: 5000,
      offsetMs: -175,
    });
    expect(f.provider.publishClock).toHaveBeenLastCalledWith({
      epoch: 7,
      seq: 3,
      trackKey: "a",
      playing: true,
      positionMs: 5000,
      offsetMs: -175,
      rate: 1,
    });
    await f.session.dispose();
  });

  it("窗口事件revision优先于迟到RPC；异步失败明确保留；可见时仅一个采样器", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.session.start();
    const response = deferred<LyricsWindowState>();
    vi.mocked(f.provider.setVisible).mockReturnValueOnce(response.promise);
    const opening = f.session.requestVisible(true);
    await flush();
    f.windows.forEach((listener) => listener(state(4, { visible: true })));
    f.windows.forEach((listener) => listener(state(5, { visible: true })));
    response.resolve(state(2, { pending: true }));
    await opening;
    expect(f.session.window.value?.revision).toBe(5);
    expect(vi.getTimerCount()).toBe(1);
    const snapshots = f.snapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(750);
    expect(f.provider.publishClock).toHaveBeenCalledTimes(3);
    expect(f.snapshot).toHaveBeenCalledTimes(snapshots);
    f.windows.forEach((listener) => listener(state(6, { failure: "attach-timeout" })));
    expect(f.session.failure.value).toBe("attach-timeout");
    expect(vi.getTimerCount()).toBe(0);
    f.windows.forEach((listener) => listener(state(99, { epoch: 6, visible: true })));
    expect(f.session.window.value?.revision).toBe(6);
    await f.session.dispose();
    expect(f.windows.size + f.commands.size + f.seeks.size).toBe(0);
  });

  it("切歌拒旧命令、同轮排队后再次校验；seek/rate/offset时钟不复制歌词", async () => {
    const f = fixture();
    await f.session.start();
    const command: LyricsCommand = { epoch: 7, trackKey: "a", action: "toggle" };
    f.commands.forEach((listener) => listener(command));
    f.data.track = "b";
    f.data.name = "B";
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    f.commands.forEach((listener) => listener(command));
    f.commands.forEach((listener) => listener({ ...command, epoch: 6, trackKey: "b" }));
    f.commands.forEach((listener) => listener({ ...command, trackKey: "b" }));
    await flush();
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({ ...command, trackKey: "b" });
    expect(f.provider.publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackKey: "b", playName: "B" }),
    );
    const snapshots = f.snapshot.mock.calls.length;
    f.data.rate = 1.5;
    f.data.offset = 250;
    await flush();
    f.data.position = 9999;
    f.seeks.forEach((listener) => listener());
    await flush();
    expect(f.snapshot).toHaveBeenCalledTimes(snapshots);
    expect(f.provider.publishClock).toHaveBeenLastCalledWith(
      expect.objectContaining({ trackKey: "b", rate: 1.5, offsetMs: 250, positionMs: 9999 }),
    );
    await f.session.dispose();
  });

  it("dispose先退订，迟到Begin只teardown对应epoch且不撤销新会话", async () => {
    const old = fixture();
    const pending = deferred<{ epoch: number }>();
    vi.mocked(old.provider.begin).mockReturnValueOnce(pending.promise);
    const starting = old.session.start();
    const disposing = old.session.dispose();
    expect(old.windows.size + old.commands.size).toBe(0);
    const fresh = fixture();
    await fresh.session.start();
    pending.resolve({ epoch: 3 });
    await starting;
    await disposing;
    expect(old.provider.teardown).toHaveBeenCalledExactlyOnceWith(3);
    expect(old.provider.publishSnapshot).not.toHaveBeenCalled();
    expect(old.session.ready.value).toBe(false);
    expect(desktopLyricsSession.value).toBe(fresh.session);
    await fresh.session.dispose();
  });

  it("显示失败reject；迟到snapshot不复活已dispose会话或触发显示", async () => {
    const f = fixture();
    await f.session.start();
    vi.mocked(f.provider.setVisible).mockRejectedValueOnce(new Error("display unavailable"));
    await expect(f.session.requestVisible(true)).rejects.toThrow("display unavailable");
    expect(f.session.failure.value).toBeInstanceOf(Error);
    const late = deferred<void>();
    vi.mocked(f.provider.publishSnapshot).mockReturnValueOnce(late.promise);
    const showing = f.session.requestVisible(true);
    await flush();
    await f.session.dispose();
    late.resolve();
    await expect(showing).rejects.toThrow("已失效");
    expect(f.provider.setVisible).toHaveBeenCalledTimes(1);
    expect(f.session.ready.value).toBe(false);
    await expect(f.session.publishClock()).rejects.toThrow("失效");
  });
});
