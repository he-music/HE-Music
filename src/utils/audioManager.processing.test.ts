import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ isElectron: false }));
vi.mock("./env", () => host);
class Media extends EventTarget {
  src = "";
  crossOrigin: string | null = null;
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 180;
  readyState = 1;
  paused = true;
  error: { code: number } | null = null;
  setSinkId = vi.fn<(device: string) => Promise<void>>(async () => {});
  load = vi.fn(() => {
    this.currentTime = 0;
    this.dispatchEvent(new Event("loadstart"));
  });
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
}
class GraphNode {
  gain = {
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((value: number) => {
      this.gain.value = value;
    }),
    linearRampToValueAtTime: vi.fn((value: number) => {
      this.gain.value = value;
    }),
  };
  frequency = { value: 0 };
  Q = { value: 0 };
  type = "";
  fftSize = 0;
  frequencyBinCount = 2;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteFrequencyData(data: Uint8Array) {
    data.set([12, 34]);
  }
}
class Context {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = new GraphNode();
  filters: GraphNode[] = [];
  gain = new GraphNode();
  sourceElement: Media | undefined;
  setSinkId = vi.fn<(device: string) => Promise<void>>(async () => {});
  createMediaElementSource(element: Media) {
    this.sourceElement = element;
    return new GraphNode();
  }
  createAnalyser() {
    return new GraphNode();
  }
  createGain() {
    return this.gain;
  }
  createBiquadFilter() {
    const filter = new GraphNode();
    this.filters.push(filter);
    return filter;
  }
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn(async () => {
    this.state = "running";
  });
}
const elements: Media[] = [];
const contexts: Context[] = [];
const fetcher = vi.fn();
let manager: typeof import("./audioManager").default;
let available: typeof import("./audioManager").audioProcessingAvailable;
beforeEach(async () => {
  vi.resetModules();
  host.isElectron = false;
  fetcher.mockResolvedValue({ ok: true, body: { cancel: vi.fn(async () => {}) } });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Audio", function () {
    const element = new Media();
    elements.push(element);
    return element;
  });
  vi.stubGlobal("AudioContext", function () {
    const context = new Context();
    contexts.push(context);
    return context;
  });
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });
  ({ default: manager, audioProcessingAvailable: available } = await import("./audioManager"));
});
afterEach(() => {
  manager.clearSource();
  elements.length = 0;
  contexts.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetcher.mockReset();
});
const lastContext = () =>
  contexts.at(-1) ??
  (() => {
    throw new Error("Missing graph");
  })();
const lastMedia = () =>
  [...elements].reverse().find((element) => element.src !== "") ??
  elements.at(-1) ??
  (() => {
    throw new Error("Missing media");
  })();
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};

describe("production AudioManager Web Audio consumption", () => {
  it("uses the source graph for EQ and spectrum, applies volume once, and restores saved gains on the next source", async () => {
    manager.setVolume(0.4);
    manager.setRate(1.25);
    manager.setFilterGain(2, 6);
    await manager.play("https://audio.invalid/cors.mp3");
    const first = lastContext();
    expect(available.value).toBe(true);
    expect(first.sourceElement?.volume).toBe(1);
    expect(first.gain.gain.value).toBe(0.4);
    expect(first.sourceElement?.playbackRate).toBe(1.25);
    expect(first.filters[2].gain.value).toBe(6);
    expect([...manager.getFrequencyData()]).toEqual([12, 34]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://audio.invalid/cors.mp3",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        headers: { Range: "bytes=0-0" },
      }),
    );
    await manager.play("https://audio.invalid/next.mp3");
    expect(first.sourceElement?.src).toBe("");
    expect(first.sourceElement?.paused).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(lastContext().filters[2].gain.value).toBe(6);
  });
  it("retains ordinary playback for sources without CORS and never binds the plain element", async () => {
    fetcher.mockRejectedValueOnce(new TypeError("synthetic CORS failure"));
    manager.setVolume(0.4);
    await manager.play("http://127.0.0.1:12456/ticket");
    expect(contexts).toHaveLength(0);
    expect(available.value).toBe(false);
    expect(lastMedia().crossOrigin).toBeNull();
    expect(lastMedia().volume).toBe(0.4);
    expect(lastMedia().paused).toBe(false);
    manager.clearSource();
    expect(manager.src).toBe("");
    expect(elements.every((element) => element.src === "" && element.paused)).toBe(true);
  });
  it("falls back to a fresh plain owner after a graph media error while retaining seek, rate and volume", async () => {
    manager.setVolume(0.6);
    manager.setRate(1.5);
    await manager.play("https://audio.invalid/cors.mp3");
    const graphElement = lastMedia();
    manager.seek(42);
    const errors = vi.fn();
    manager.on("error", errors);
    graphElement.error = { code: 4 };
    graphElement.dispatchEvent(new Event("error"));
    await flush();
    expect(available.value).toBe(false);
    expect(graphElement.src).toBe("");
    expect(lastMedia()).not.toBe(graphElement);
    expect(manager.currentTime).toBe(42);
    expect(lastMedia().volume).toBe(0.6);
    expect(lastMedia().playbackRate).toBe(1.5);
    expect(lastMedia().paused).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });
  it("clearSource revokes an unresolved source load so a late probe cannot load or play it", async () => {
    let resolve: (value: { ok: boolean }) => void = () => {
      throw new Error("missing probe");
    };
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = manager.play("https://audio.invalid/pending.mp3");
    await flush();
    manager.clearSource();
    resolve({ ok: true });
    await pending;
    expect(contexts).toHaveLength(0);
    expect(elements.every((element) => element.src === "" && element.paused)).toBe(true);
    expect(manager.src).toBe("");
  });
  it("pause cancels autoPlay while preserving an in-flight preload", async () => {
    let resolve: (value: { ok: boolean }) => void = () => {
      throw new Error("missing probe");
    };
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = manager.play("https://audio.invalid/pending.mp3");
    await flush();
    manager.pause({ fadeOut: true });
    resolve({ ok: true });
    await pending;
    expect(manager.src).toBe("https://audio.invalid/pending.mp3");
    expect(lastMedia().paused).toBe(true);
    expect(lastMedia().play).not.toHaveBeenCalled();
    await manager.play();
    expect(lastMedia().paused).toBe(false);
  });
  it("a fade-out pause follows the same source when a graph error replaces its output owner", async () => {
    vi.useFakeTimers();
    try {
      await manager.play("https://audio.invalid/fading.mp3");
      const graphElement = lastMedia();
      manager.pause({ fadeOut: true, fadeDuration: 1 });
      graphElement.error = { code: 4 };
      graphElement.dispatchEvent(new Event("error"));
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.src).toBe("https://audio.invalid/fading.mp3");
      expect(lastMedia().paused).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("restores the desired device on the current graph context and on a plain fallback or replacement source", async () => {
    await manager.setSinkId("speakers");
    await manager.play("https://audio.invalid/output.mp3");
    const graph = lastContext();
    expect(graph.setSinkId).toHaveBeenCalledExactlyOnceWith("speakers");
    expect(graph.sourceElement?.setSinkId).not.toHaveBeenCalled();
    graph.sourceElement?.dispatchEvent(new Event("error"));
    await flush();
    expect(lastMedia().setSinkId).toHaveBeenCalledWith("speakers");
    fetcher.mockRejectedValueOnce(new TypeError("synthetic CORS"));
    await manager.play("https://audio.invalid/plain-next.mp3");
    expect(lastMedia().setSinkId).toHaveBeenCalledExactlyOnceWith("speakers");
    await manager.setSinkId("default");
    expect(lastMedia().setSinkId).toHaveBeenLastCalledWith("default");
  });
  it("preserves the Electron graph path without running a CORS probe", async () => {
    host.isElectron = true;
    vi.resetModules();
    const electron = (await import("./audioManager")).default;
    electron.setFilterGain(1, 3);
    await electron.play("https://audio.invalid/electron.mp3");
    expect(fetcher).not.toHaveBeenCalled();
    expect(lastContext().filters[1].gain.value).toBe(3);
    expect(lastMedia().crossOrigin).toBe("anonymous");
    electron.clearSource();
  });
});
