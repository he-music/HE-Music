import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IPlaybackEngine,
  PlaybackEngineId,
  PlaybackEvent,
} from "@/core/audio-player/IPlaybackEngine";

const doubles = vi.hoisted(() => ({ engines: new Map<PlaybackEngineId, IPlaybackEngine>() }));
vi.mock("@/core/audio-player/BrowserPlaybackEngine", () => ({
  BrowserPlaybackEngine: class {
    constructor() {
      const engine = doubles.engines.get("web-audio");
      if (!engine) throw new Error("browser");
      return engine;
    }
  },
}));
vi.mock("@/core/audio-player/MpvPlaybackEngine", () => ({
  MpvPlaybackEngine: class {
    constructor() {
      const engine = doubles.engines.get("mpv");
      if (!engine) throw new Error("mpv");
      return engine;
    }
  },
}));
vi.mock("@/platform", () => ({ platform: { mpvPlayback: {} } }));
function engine(id: PlaybackEngineId) {
  const listeners = new Set<(event: PlaybackEvent) => void>();
  const value: IPlaybackEngine = {
    id,
    capabilities: {
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: false,
      supportsSpectrum: false,
      supportsFade: false,
    },
    state: "paused",
    currentTime: 12,
    duration: 90,
    paused: true,
    src: "source",
    sessionId: 1,
    error: undefined,
    init: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    clearSource: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    getVolume: () => 0.5,
    setRate: vi.fn(async () => {}),
    getRate: () => 1.5,
    getOutputDevices: vi.fn(async () => []),
    setSinkId: vi.fn(async () => {}),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { value, listeners };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { resolve, promise };
}
beforeEach(() => {
  vi.resetModules();
  doubles.engines.clear();
});

describe("AudioManager 引擎切换", () => {
  it("等待旧源和旧实例释放后才初始化新引擎，忽略旧事件", async () => {
    const old = engine("web-audio"),
      native = engine("mpv");
    doubles.engines.set("web-audio", old.value);
    doubles.engines.set("mpv", native.value);
    const { AudioManager } = await import("./audioManager");
    const manager = new AudioManager(old.value);
    const end = vi.fn();
    manager.on("ended", end);
    const delayedEvent = [...old.listeners];
    const release = deferred();
    vi.mocked(old.value.clearSource).mockReturnValue(release.promise);
    const switching = manager.setEngine("mpv");
    await vi.waitFor(() => expect(old.value.clearSource).toHaveBeenCalled());
    expect(native.value.init).not.toHaveBeenCalled();
    release.resolve();
    await switching;
    expect(old.value.destroy).toHaveBeenCalledOnce();
    expect(native.value.init).toHaveBeenCalledOnce();
    for (const listener of delayedEvent) listener({ type: "ended", sessionId: 1 });
    expect(end).not.toHaveBeenCalled();
    expect(manager.engineId).toBe("mpv");
  });
  it("切换失败仍停留新引擎，不自动回退", async () => {
    const old = engine("web-audio"),
      native = engine("mpv");
    doubles.engines.set("web-audio", old.value);
    doubles.engines.set("mpv", native.value);
    vi.mocked(native.value.init).mockRejectedValueOnce(new Error("library"));
    const { AudioManager } = await import("./audioManager");
    const manager = new AudioManager(old.value);
    await expect(manager.setEngine("mpv")).rejects.toThrow("library");
    expect(manager.engineId).toBe("mpv");
    expect(old.value.play).not.toHaveBeenCalled();
  });
  it("切换中的新 clearSource 等待引擎替换，不调用正在销毁的旧实例", async () => {
    const old = engine("web-audio"),
      native = engine("mpv");
    doubles.engines.set("web-audio", old.value);
    doubles.engines.set("mpv", native.value);
    const release = deferred();
    vi.mocked(old.value.destroy).mockReturnValue(release.promise);
    const { AudioManager } = await import("./audioManager");
    const manager = new AudioManager(old.value);
    const switching = manager.setEngine("mpv");
    await vi.waitFor(() => expect(old.value.destroy).toHaveBeenCalled());
    const clear = manager.clearSource();
    expect(old.value.clearSource).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([switching, clear]);
    expect(native.value.clearSource).toHaveBeenCalledOnce();
  });
});
