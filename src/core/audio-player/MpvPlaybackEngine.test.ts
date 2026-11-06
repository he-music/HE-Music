import { describe, expect, it, vi } from "vitest";
import type { MpvEvent, MpvSnapshot, PlatformMpvPlayback } from "@/platform/mpvPlayback";
import { MpvPlaybackEngine } from "./MpvPlaybackEngine";

function setup() {
  let snapshot: MpvSnapshot = {
    lifecycle: 1,
    session: 0,
    sequence: 1,
    state: "idle",
    position: 0,
    duration: 90,
    rate: 1,
    volume: 1,
    source: "",
    device: "auto",
    error: null,
  };
  let listener: ((event: MpvEvent) => void) | undefined;
  const next = (patch: Partial<MpvSnapshot> = {}) =>
    (snapshot = { ...snapshot, sequence: snapshot.sequence + 1, ...patch });
  const emit = (type: MpvEvent["type"], patch: Partial<MpvSnapshot> = {}) =>
    listener?.({ type, snapshot: next(patch) });
  const provider: PlatformMpvPlayback = {
    capabilities: {
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: false,
      supportsSpectrum: false,
      supportsFade: false,
    },
    initialize: vi.fn(async () => snapshot),
    load: vi.fn(async (_lifecycle, request) =>
      next({
        session: snapshot.session + 1,
        source: request.url,
        position: request.start,
        state: "paused",
      }),
    ),
    play: vi.fn(async () => {
      emit("playing", { state: "playing" });
    }),
    pause: vi.fn(async () => {
      emit("pause", { state: "paused" });
    }),
    stop: vi.fn(async () => next({ session: snapshot.session + 1, state: "idle" })),
    clearSource: vi.fn(async () =>
      next({ session: snapshot.session + 1, state: "idle", source: "", position: 0 }),
    ),
    seek: vi.fn(async (_lifecycle, _session, seconds) => {
      next({ position: seconds });
    }),
    setVolume: vi.fn(async () => {}),
    setRate: vi.fn(async () => {}),
    getOutputDevices: vi.fn(async () => [{ id: "auto", label: "Default", available: true }]),
    setOutputDevice: vi.fn(async () => {}),
    snapshot: vi.fn(async () => next()),
    destroy: vi.fn(async () => {}),
    onEvent: vi.fn((callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
    teardown: vi.fn(),
  };
  return {
    provider,
    engine: new MpvPlaybackEngine(provider),
    emit,
    next,
    send: (event: MpvEvent) => listener?.(event),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("MpvPlaybackEngine", () => {
  it("先暂停加载、恢复音量倍速，再播放；高频 getter 不调用 Go", async () => {
    const { engine, provider } = setup();
    await engine.setVolume(0.4);
    await engine.setRate(1.5);
    await engine.play("gateway", {
      seek: 12,
      source: { platform: "local", format: "dsf", fileEpoch: 3, identity: "song-id" },
    });
    expect(provider.load).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ autoPlay: false, start: 12, format: "dsf", fileEpoch: 3 }),
    );
    expect(provider.setVolume).toHaveBeenLastCalledWith(1, 1, 0.4);
    expect(provider.setRate).toHaveBeenLastCalledWith(1, 1, 1.5);
    expect(provider.play).toHaveBeenCalledOnce();
    for (let i = 0; i < 500; i++) void engine.currentTime;
    expect(provider.snapshot).not.toHaveBeenCalled();
    expect(engine.src).toBe("song-id");
  });
  it.each(["pause", "clear"])("加载期间 %s 不复活播放", async (operation) => {
    const { engine, provider, next } = setup();
    const loading = deferred<MpvSnapshot>();
    vi.mocked(provider.load).mockReturnValueOnce(loading.promise);
    const play = engine.play("A");
    await vi.waitFor(() => expect(provider.load).toHaveBeenCalled());
    const cancel = operation === "pause" ? engine.pause() : engine.clearSource();
    loading.resolve(next({ session: 1, state: "paused" }));
    await Promise.all([play, cancel]);
    expect(provider.play).not.toHaveBeenCalled();
    if (operation === "clear") expect(provider.clearSource).toHaveBeenCalledWith(1, 1);
  });
  it("暂停预加载期间显式播放读取最新意图", async () => {
    const { engine, provider, next } = setup();
    const loading = deferred<MpvSnapshot>();
    vi.mocked(provider.load).mockReturnValueOnce(loading.promise);
    const play = engine.play("A", { autoPlay: false });
    await vi.waitFor(() => expect(provider.load).toHaveBeenCalled());
    await engine.play();
    loading.resolve(next({ session: 1, state: "paused" }));
    await play;
    expect(provider.play).toHaveBeenCalledOnce();
  });
  it("缓冲快照转换等待和恢复事件", async () => {
    const { engine, emit } = setup();
    await engine.play("A");
    const events: string[] = [];
    engine.onEvent((event) => events.push(event.type));
    emit("timeupdate", { state: "buffering", position: 5 });
    expect(events).toEqual(["waiting", "timeupdate"]);
    expect(engine.currentTime).toBe(5);
    emit("timeupdate", { state: "playing", position: 6 });
    expect(events).toEqual(["waiting", "timeupdate", "playing", "timeupdate"]);
  });
  it("快速换源时忽略尚未发出新加载前的旧错误", async () => {
    const { engine, provider, next, send } = setup();
    const loading = deferred<MpvSnapshot>();
    vi.mocked(provider.load).mockReturnValueOnce(loading.promise);
    const first = engine.play("A");
    await vi.waitFor(() => expect(provider.load).toHaveBeenCalled());
    const second = engine.play("B");
    const events = vi.fn();
    engine.onEvent(events);
    send({
      type: "error",
      snapshot: next({ session: 1, error: { kind: "decode", message: "old" }, state: "error" }),
    });
    expect(events).not.toHaveBeenCalled();
    loading.resolve(next({ session: 1, error: null, state: "paused" }));
    await Promise.all([first, second]);
    expect(provider.play).toHaveBeenCalledTimes(1);
    expect(engine.src).toBe("B");
    expect(engine.error).toBeUndefined();
  });
  it("旧会话与逆序快照不触发下一首或回退位置", async () => {
    const { engine, provider, next, send } = setup();
    const events = vi.fn();
    engine.onEvent(events);
    await engine.play("A");
    await engine.play("B");
    events.mockClear();
    send({ type: "ended", snapshot: { ...next(), session: 1, state: "ended", position: 89 } });
    expect(events).not.toHaveBeenCalled();
    send({ type: "ended", snapshot: { ...next(), lifecycle: 0, session: 2, state: "ended" } });
    send({ type: "ended", snapshot: { ...next(), sequence: 1, session: 3, state: "ended" } });
    expect(events).not.toHaveBeenCalled();
    await engine.seek(30);
    send({ type: "timeupdate", snapshot: { ...next(), sequence: 1, session: 2, position: 1 } });
    expect(engine.currentTime).toBeGreaterThanOrEqual(30);
    expect(provider.snapshot).toHaveBeenCalledOnce();
  });
  it.each(["seek", "setRate"] as const)(
    "%s 命令快照先到也不会吞掉当前会话的结束或错误通知",
    async (command) => {
      for (const type of ["ended", "error"] as const) {
        for (const newer of [false, true]) {
          const { engine, provider, next, send } = setup();
          await engine.play("A");
          const events = vi.fn();
          engine.onEvent(events);
          const terminal = next({
            state: type,
            position: 45,
            error: type === "error" ? { kind: "decode", message: "late error" } : null,
          });
          const correction = newer
            ? next({ position: 46, state: "paused", error: null })
            : terminal;
          vi.mocked(provider.snapshot).mockResolvedValueOnce(correction);
          if (command === "seek") await engine.seek(45);
          else await engine.setRate(1.5);
          send({ type, snapshot: terminal });
          send({ type, snapshot: terminal });
          expect(events).toHaveBeenCalledExactlyOnceWith({
            type,
            sessionId: terminal.session,
            error: type === "error" ? { kind: "decode", message: "late error" } : undefined,
          });
          expect(engine.currentTime).toBe(correction.position);
          await engine.play("B");
          events.mockClear();
          send({ type, snapshot: terminal });
          expect(events).not.toHaveBeenCalled();
          await engine.destroy();
        }
      }
    },
  );
  it("默认设备映射 auto，失效设备暂停并抛错", async () => {
    const { engine, provider } = setup();
    await engine.setSinkId("default");
    expect(provider.setOutputDevice).toHaveBeenCalledWith(1, "auto");
    await expect(engine.setSinkId("missing")).rejects.toThrow("unavailable");
    expect(provider.pause).toHaveBeenCalled();
    expect(provider.setOutputDevice).toHaveBeenCalledTimes(1);
  });
  it("枚举错误原样报告，销毁等候真实释放", async () => {
    const { engine, provider } = setup();
    await engine.init();
    vi.mocked(provider.getOutputDevices).mockRejectedValueOnce(new Error("enumeration"));
    await expect(engine.getOutputDevices()).rejects.toThrow("enumeration");
    const released = deferred<void>();
    vi.mocked(provider.destroy).mockReturnValueOnce(released.promise);
    let done = false;
    const destroying = engine.destroy().then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(provider.destroy).toHaveBeenCalled());
    expect(done).toBe(false);
    released.resolve();
    await destroying;
    expect(done).toBe(true);
  });
});
