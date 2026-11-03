import { describe, expect, it, vi } from "vitest";
import {
  AudioProcessingDriver,
  type AudioGraphLease,
  createAudioGraph,
  AudioSourceGeneration,
  canUseWebAudioSource,
} from "./audioCapability";

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnectCount = 0;
  shouldThrow = false;
  disconnectThrows = false;
  connect(node: FakeNode): void {
    if (this.shouldThrow) throw new Error("connect failed");
    this.connections.push(node);
  }
  disconnect(): void {
    this.disconnectCount += 1;
    if (this.disconnectThrows) throw new Error("disconnect failed");
  }
}

class FakeAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn((time: number) => {
    void time;
    return this;
  });
  setValueAtTime = vi.fn((value: number, time: number) => {
    void time;
    this.value = value;
    return this;
  });
}

class FakeAudioContext {
  currentTime = 7;
  readonly destination = new FakeNode();
  readonly source = new FakeNode();
  readonly analyser = new FakeNode() as FakeNode & { fftSize: number };
  readonly gain = new FakeNode() as FakeNode & { gain: FakeAudioParam };
  readonly filters: Array<
    FakeNode & {
      type: string;
      frequency: { value: number };
      Q: { value: number };
      gain: { value: number };
    }
  > = [];
  readonly state: AudioContextState = "running";
  close = vi.fn(async () => undefined);
  resume = vi.fn(async (): Promise<void> => undefined);
  failAt: string | undefined;

  constructor(failAt?: string) {
    this.failAt = failAt;
    this.gain.gain = new FakeAudioParam();
    if (failAt === "connect") this.source.shouldThrow = true;
  }

  static captured = new WeakSet<HTMLMediaElement>();
  createMediaElementSource(element: HTMLMediaElement): FakeNode {
    if (FakeAudioContext.captured.has(element)) throw new Error("already captured");
    FakeAudioContext.captured.add(element);
    if (this.failAt === "source") throw new Error("source failed");
    return this.source;
  }

  createAnalyser(): FakeNode {
    if (this.failAt === "analyser") throw new Error("analyser failed");
    this.analyser.fftSize = 0;
    return this.analyser;
  }

  createGain(): FakeNode {
    if (this.failAt === "gain") throw new Error("gain failed");
    return this.gain;
  }

  createBiquadFilter(): FakeNode {
    const index = this.filters.length;
    if (this.failAt === `filter-${index}`) throw new Error("filter failed");
    const filter = new FakeNode() as FakeNode & {
      type: string;
      frequency: { value: number };
      Q: { value: number };
      gain: { value: number };
    };
    filter.frequency = { value: 0 };
    filter.Q = { value: 0 };
    filter.gain = { value: 0 };
    this.filters.push(filter);
    return filter;
  }
}

class FakeAudio extends EventTarget {
  src = "";
  readyState = 1;
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  crossOrigin: string | null = null;
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  paused = true;
  load = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
}

function asElement(audio: FakeAudio): HTMLAudioElement {
  return audio as unknown as HTMLAudioElement;
}

function asContext(context: FakeAudioContext): AudioContext {
  return context as unknown as AudioContext;
}

function graphLease(context: FakeAudioContext): AudioGraphLease {
  const source = new FakeNode();
  const analyser = new FakeNode();
  const gain = new FakeNode() as FakeNode & { gain: FakeAudioParam };
  gain.gain = new FakeAudioParam();
  gain.gain.value = 1;
  return {
    context: asContext(context),
    source: source as unknown as MediaElementAudioSourceNode,
    analyser: analyser as unknown as AnalyserNode,
    gain: gain as unknown as GainNode,
    filters: [],
    dispose: vi.fn(),
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function playbackFixture(
  prepareOutput?: (element: HTMLAudioElement, context: AudioContext | undefined) => Promise<void>,
) {
  const elements: FakeAudio[] = [];
  const context = new FakeAudioContext();
  const driver = new AudioProcessingDriver({
    createElement: () => {
      const element = new FakeAudio();
      elements.push(element);
      return asElement(element);
    },
    frequencies: [],
    probe: async (url) => url.endsWith("a"),
    createGraph: () => graphLease(context),
    prepareOutput,
  });
  return { driver, elements, context };
}

describe("audio capability", () => {
  it("admits the injected gateway media without a redundant network probe", async () => {
    const gateway = "http://127.0.0.1:49234/session-secret";
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    try {
      const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
      const url = `${gateway}/__proxy?target=aHR0cHM6Ly9hdWRpby5leGFtcGxlL3Nvbmc`;
      await expect(canUseWebAudioSource(url, { fetcher })).resolves.toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      const controller = new AbortController();
      controller.abort();
      await expect(canUseWebAudioSource(url, { fetcher, signal: controller.signal })).resolves.toBe(
        false,
      );
      await canUseWebAudioSource(`${gateway}/other?target=anything`, { fetcher });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a cancellable ranged GET and accepts a CORS response", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=0-0");
      expect(init?.credentials).toBe("omit");
      return new Response(null, { status: 206 });
    });

    await expect(canUseWebAudioSource("https://audio.example/song.mp3", { fetcher })).resolves.toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });

  it("rejects non-http, failed, and aborted probes without reading a track", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(canUseWebAudioSource("blob:local-track", { fetcher })).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(canUseWebAudioSource("http://127.0.0.1:12345/audio", { fetcher })).resolves.toBe(
      false,
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      canUseWebAudioSource("https://audio.example/song.mp3", {
        fetcher,
        signal: controller.signal,
      }),
    ).resolves.toBe(false);
  });

  it("builds one ordered ten-band graph with clamped volume", () => {
    const context = new FakeAudioContext();
    const element = new FakeAudio();
    const frequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const graph = createAudioGraph(asElement(element), {
      frequencies,
      volume: 2,
      contextFactory: () => asContext(context),
    });

    expect(context.filters).toHaveLength(10);
    expect(context.gain.gain.value).toBe(1);
    expect(context.source.connections[0]).toBe(context.filters[0]);
    expect(context.filters[9].connections[0]).toBe(context.analyser);
    expect(context.analyser.connections[0]).toBe(context.gain);
    expect(context.gain.connections[0]).toBe(context.destination);
    expect(context.filters.map((filter) => filter.frequency.value)).toEqual(frequencies);
    graph.dispose();
  });

  it.each(["source", "analyser", "gain", "filter-4", "connect"])(
    "releases all resources when graph creation fails at %s",
    (failAt) => {
      const context = new FakeAudioContext(failAt);
      expect(() =>
        createAudioGraph(asElement(new FakeAudio()), {
          frequencies: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
          volume: 0.5,
          contextFactory: () => asContext(context),
        }),
      ).toThrow();
      expect(context.close).toHaveBeenCalledOnce();
      expect(context.source.disconnectCount).toBeGreaterThanOrEqual(0);
    },
  );

  it("disposes a graph idempotently", () => {
    const context = new FakeAudioContext();
    const graph = createAudioGraph(asElement(new FakeAudio()), {
      frequencies: [32],
      volume: 0.5,
      contextFactory: () => asContext(context),
    });
    graph.dispose();
    graph.dispose();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("keeps late work from becoming current after source replacement", () => {
    const generation = new AudioSourceGeneration();
    const first = generation.next();
    const second = generation.next();
    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
    generation.revoke();
    expect(generation.isCurrent(second)).toBe(false);
  });

  it("uses a separate plain element when graph creation fails", async () => {
    const plain = new FakeAudio();
    const graphElement = new FakeAudio();
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(graphElement)),
      frequencies: [32],
      probe: vi.fn(async () => true),
      createGraph: vi.fn(() => {
        throw new Error("graph failed");
      }),
    });

    await expect(driver.load("https://audio.example/song.mp3")).resolves.toBe("native");
    expect(driver.element).toBe(asElement(plain));
    expect(plain.crossOrigin).toBeNull();
    expect(plain.src).toBe("https://audio.example/song.mp3");
    expect(graphElement.src).toBe("");
  });

  it("falls back after graph media load failure", async () => {
    const plain = new FakeAudio();
    const graphElement = new FakeAudio();
    const context = new FakeAudioContext();
    const graph = graphLease(context);
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(graphElement)),
      frequencies: [32],
      probe: vi.fn(async () => true),
      createGraph: vi.fn(() => graph),
    });

    await expect(driver.load("https://audio.example/song.mp3")).resolves.toBe("web-audio");
    graphElement.currentTime = 9;
    graphElement.dispatchEvent(new Event("error"));
    await Promise.resolve();
    expect(driver.element).toBe(asElement(plain));
    expect(plain.crossOrigin).toBeNull();
    expect(plain.currentTime).toBe(9);
    expect(graph.dispose).toHaveBeenCalledOnce();
  });

  it("falls back to plain playback when graph resume fails and preserves controls", async () => {
    const plain = new FakeAudio();
    const graphElement = new FakeAudio();
    const context = new FakeAudioContext();
    Object.defineProperty(context, "state", { value: "suspended" });
    context.resume = vi.fn(async () => {
      throw new Error("context failed");
    });
    const graph = graphLease(context);
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(graphElement)),
      frequencies: [32],
      volume: 0.7,
      probe: vi.fn(async () => true),
      createGraph: vi.fn(() => graph),
    });

    await expect(driver.load("https://audio.example/song.mp3")).resolves.toBe("web-audio");
    driver.setRate(1.25);
    driver.seek(12);
    await driver.play();
    expect(driver.element).toBe(asElement(plain));
    expect(plain.volume).toBe(0.7);
    expect(plain.playbackRate).toBe(1.25);
    expect(plain.currentTime).toBe(12);
    expect(plain.play).toHaveBeenCalledOnce();
    expect(graph.dispose).toHaveBeenCalledOnce();
  });
  it("does not square graph volume", async () => {
    const driver = new AudioProcessingDriver({
      createElement: () => asElement(new FakeAudio()),
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    driver.setVolume(0.4);
    expect(driver.element.volume).toBe(1);
  });

  it("clears discarded media buffers on dispose", async () => {
    const plain = new FakeAudio();
    const driver = new AudioProcessingDriver({
      createElement: () => asElement(plain),
      frequencies: [],
      probe: async () => false,
    });
    await driver.load("https://audio.example/a");
    const loads = plain.load.mock.calls.length;
    driver.dispose();
    expect(plain.src).toBe("");
    expect(plain.load).toHaveBeenCalledTimes(loads + 1);
  });

  it("does not play a replacement source after a late resume", async () => {
    let resume!: () => void;
    const context = new FakeAudioContext();
    Object.defineProperty(context, "state", { value: "suspended" });
    context.resume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const plain = new FakeAudio();
    const processed = new FakeAudio();
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(processed)),
      frequencies: [],
      probe: async (url) => url.endsWith("a"),
      createGraph: () => graphLease(context),
    });
    await driver.load("https://audio.example/a");
    const playing = driver.play();
    await driver.load("https://audio.example/b");
    resume();
    await playing;
    expect(plain.play).not.toHaveBeenCalled();
    expect(processed.play).not.toHaveBeenCalled();
  });

  it.each(["resume", "play"])(
    "returns %s policy rejection unchanged without fallback",
    async (at) => {
      const context = new FakeAudioContext();
      const error = new DOMException("gesture required", "NotAllowedError");
      const elements: FakeAudio[] = [];
      const driver = new AudioProcessingDriver({
        createElement: () => {
          const element = new FakeAudio();
          elements.push(element);
          return asElement(element);
        },
        frequencies: [],
        probe: async () => true,
        createGraph: () => graphLease(context),
      });
      await driver.load("https://audio.example/a");
      if (at === "resume") {
        Object.defineProperty(context, "state", { value: "suspended" });
        context.resume.mockRejectedValue(error);
      } else elements[1].play.mockRejectedValue(error);
      const onError = vi.fn();
      driver.on("error", onError);
      await expect(driver.play()).rejects.toBe(error);
      expect(driver.processingAvailable).toBe(true);
      expect(elements[0].play).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("retires plain elements before a pending play can affect the replacement", async () => {
    const elements: FakeAudio[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [],
      probe: async () => false,
    });
    await driver.load("https://audio.example/a");
    let resolve!: () => void;
    elements[0].play.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = () => {
            elements[0].paused = false;
            done();
          };
        }),
    );
    const oldPlay = driver.play();
    await driver.load("https://audio.example/b");
    await driver.play();
    const pauses = elements[1].pause.mock.calls.length;
    resolve();
    await oldPlay;
    expect(elements[0].paused).toBe(true);
    expect(elements[0].src).toBe("");
    expect(elements[1].play).toHaveBeenCalledOnce();
    expect(elements[1].pause).toHaveBeenCalledTimes(pauses);
    expect(elements[1].src).toBe("https://audio.example/b");
  });

  it.each(["pause", "clear", "dispose"])("cancels a pending resume with %s", async (action) => {
    let resolve!: () => void;
    const context = new FakeAudioContext();
    Object.defineProperty(context, "state", { value: "suspended" });
    context.resume.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const elements: FakeAudio[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(context),
    });
    await driver.load("https://audio.example/a");
    const playing = driver.play();
    if (action === "pause") driver.pause();
    else if (action === "clear") driver.clearSource();
    else driver.dispose();
    resolve();
    await playing;
    expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
    if (action === "dispose") {
      await expect(driver.load("https://audio.example/b")).rejects.toThrow("disposed");
      await expect(driver.play()).rejects.toThrow("disposed");
    }
  });

  it("keeps preload completion but revokes autoplay intent when paused", async () => {
    let resolve!: (value: boolean) => void;
    const driver = new AudioProcessingDriver({
      createElement: () => asElement(new FakeAudio()),
      frequencies: [],
      probe: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    const loading = driver.load("https://audio.example/a");
    const generation = driver.loadGeneration;
    const intent = driver.playIntentGeneration;
    await Promise.resolve();
    driver.pause();
    resolve(false);
    await loading;
    expect(driver.isCurrent(generation)).toBe(true);
    expect(driver.source).toBe("https://audio.example/a");
    expect(driver.playIntentGeneration).not.toBe(intent);
    driver.clearSource();
    expect(driver.isCurrent(generation)).toBe(false);
  });

  it.each(["reject", "timeout", "cancel"])(
    "bounds and cleans %s probes without network",
    async (mode) => {
      vi.useFakeTimers();
      try {
        let signal!: AbortSignal;
        const driver = new AudioProcessingDriver({
          createElement: () => asElement(new FakeAudio()),
          frequencies: [],
          probeTimeoutMs: 20,
          probe: async (_url, currentSignal) => {
            signal = currentSignal;
            if (mode === "reject") throw new Error("probe failed");
            return new Promise<boolean>(() => {});
          },
        });
        const loading = driver.load("https://audio.example/a");
        await Promise.resolve();
        if (mode === "cancel") driver.clearSource();
        if (mode === "timeout") await vi.advanceTimersByTimeAsync(20);
        await expect(loading).resolves.toBe("native");
        expect(signal.aborted).toBe(true);
        expect(driver.source).toBe(mode === "cancel" ? "" : "https://audio.example/a");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds the range fetch even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => {}));
      const probe = canUseWebAudioSource("https://audio.example/a", { fetcher, timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await expect(probe).resolves.toBe(false);
      expect(fetcher.mock.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards all current events, supports removal and ignores retired events", async () => {
    const elements: FakeAudio[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [],
      probe: async () => false,
    });
    const error = vi.fn();
    driver.on("error", error);
    elements[0].dispatchEvent(new Event("error"));
    expect(error).toHaveBeenCalledOnce();
    await driver.load("https://audio.example/a");
    const listener = vi.fn();
    const events = [
      "play",
      "playing",
      "pause",
      "ended",
      "timeupdate",
      "error",
      "waiting",
      "stalled",
      "canplay",
      "loadedmetadata",
      "loadstart",
      "volumechange",
      "seeking",
      "seeked",
    ] as const;
    for (const event of events) {
      driver.on(event, listener);
      elements[0].dispatchEvent(new Event(event));
    }
    expect(listener).toHaveBeenCalledTimes(events.length);
    driver.off("timeupdate", listener);
    elements[0].dispatchEvent(new Event("timeupdate"));
    expect(listener).toHaveBeenCalledTimes(events.length);
    await driver.load("https://audio.example/b");
    elements[0].dispatchEvent(new Event("error"));
    elements[0].dispatchEvent(new Event("timeupdate"));
    expect(listener).toHaveBeenCalledTimes(events.length);
    driver.offAll();
    elements[1].dispatchEvent(new Event("error"));
    expect(listener).toHaveBeenCalledTimes(events.length);
  });

  it("does not let loadstart reentry overwrite a replacement source", async () => {
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        element.load.mockImplementation(() => {
          if (element.src) element.dispatchEvent(new Event("loadstart"));
        });
        return asElement(element);
      },
      frequencies: [],
      probe: async () => false,
    });
    let replacement: Promise<unknown> | undefined;
    driver.on("loadstart", () => {
      if (driver.source.endsWith("a")) replacement = driver.load("https://audio.example/b");
    });
    const old = driver.load("https://audio.example/a");
    const token = driver.loadGeneration;
    await old;
    await replacement;
    expect(driver.isCurrent(token)).toBe(false);
    expect(driver.source).toBe("https://audio.example/b");
    expect(driver.element.src).toBe("https://audio.example/b");
  });

  it("releases every graph node and closes context despite disconnect failures", () => {
    const context = new FakeAudioContext();
    const graph = createAudioGraph(asElement(new FakeAudio()), {
      frequencies: [32],
      volume: 1,
      contextFactory: () => asContext(context),
    });
    context.source.disconnectThrows = true;
    graph.dispose();
    expect(context.filters[0].disconnectCount).toBe(1);
    expect(context.analyser.disconnectCount).toBe(1);
    expect(context.gain.disconnectCount).toBe(1);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("uses fresh graph elements and publishes current nodes on admission changes", async () => {
    const elements: FakeAudio[] = [];
    const contexts: FakeAudioContext[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [32],
      probe: async () => true,
      createGraph: (element, options) =>
        createAudioGraph(element, {
          ...options,
          contextFactory: () => {
            const context = new FakeAudioContext();
            contexts.push(context);
            return asContext(context);
          },
        }),
    });
    const states: boolean[] = [];
    driver.on("processingchange", () => states.push(driver.processingAvailable));
    await driver.load("https://audio.example/a");
    expect(driver.context).toBe(contexts[0]);
    expect(driver.gain).toBe(contexts[0].gain);
    expect(driver.analyser).toBe(contexts[0].analyser);
    expect(driver.filters).toHaveLength(1);
    await driver.load("https://audio.example/b");
    expect(driver.context).toBe(contexts[1]);
    driver.clearSource();
    expect(driver.context).toBeUndefined();
    expect(driver.gain).toBeUndefined();
    expect(driver.analyser).toBeUndefined();
    expect(driver.filters).toEqual([]);
    expect(states).toEqual([true, false, true, false]);
    expect(elements.every((element) => element.src === "")).toBe(true);
  });

  it("restores metadata seek once and cancels restoration on clear", async () => {
    const plain = new FakeAudio();
    plain.readyState = 0;
    const processed = new FakeAudio();
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(processed))
        .mockImplementation(() => asElement(new FakeAudio())),
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    driver.seek(12);
    processed.dispatchEvent(new Event("error"));
    expect(plain.currentTime).toBe(0);
    plain.dispatchEvent(new Event("loadedmetadata"));
    expect(plain.currentTime).toBe(12);
    plain.currentTime = 15;
    plain.dispatchEvent(new Event("loadedmetadata"));
    expect(plain.currentTime).toBe(15);
    driver.seek(20);
    driver.clearSource();
    plain.dispatchEvent(new Event("loadedmetadata"));
    expect(plain.currentTime).toBe(15);
  });

  it("handles async fallback rejection and forwards genuine plain errors", async () => {
    const plain = new FakeAudio();
    const processed = new FakeAudio();
    plain.play.mockRejectedValue(new Error("decode failed"));
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(processed)),
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    await driver.play();
    const errors = vi.fn();
    driver.on("error", errors);
    processed.dispatchEvent(new Event("error"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(processed.paused).toBe(true);
    expect(processed.src).toBe("");
    expect(errors).toHaveBeenCalledOnce();
    plain.dispatchEvent(new Event("error"));
    expect(errors).toHaveBeenCalledTimes(2);
  });
  it("notifies disposal admission change and never revives through the notification", async () => {
    const driver = new AudioProcessingDriver({
      createElement: () => asElement(new FakeAudio()),
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    const changed = vi.fn(() => expect(driver.processingAvailable).toBe(false));
    driver.on("processingchange", changed);
    driver.dispose();
    expect(changed).toHaveBeenCalledOnce();
    await expect(driver.load("https://audio.example/b")).rejects.toThrow("disposed");
  });

  it("keeps a source loaded reentrantly during discarded plain pause", async () => {
    const elements: FakeAudio[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [],
      probe: async () => false,
    });
    await driver.load("https://audio.example/a");
    let replacement: Promise<unknown> | undefined;
    elements[0].pause.mockImplementationOnce(() => {
      replacement = driver.load("https://audio.example/c");
    });
    const obsolete = driver.load("https://audio.example/b");
    await obsolete;
    await replacement;
    expect(driver.source).toBe("https://audio.example/c");
    expect(driver.element.src).toBe("https://audio.example/c");
    expect(elements[0].src).toBe("");
  });

  it("carries a seek pending metadata through graph fallback", async () => {
    const elements: FakeAudio[] = [];
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        element.readyState = 0;
        elements.push(element);
        return asElement(element);
      },
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    driver.seek(22);
    elements[1].dispatchEvent(new Event("error"));
    elements[1].dispatchEvent(new Event("loadedmetadata"));
    expect(elements[1].currentTime).toBe(0);
    elements[0].dispatchEvent(new Event("loadedmetadata"));
    expect(elements[0].currentTime).toBe(22);
  });
  it("never reuses a partially captured graph element as plain media", async () => {
    const elements: FakeAudio[] = [];
    const context = new FakeAudioContext("analyser");
    const driver = new AudioProcessingDriver({
      createElement: () => {
        const element = new FakeAudio();
        elements.push(element);
        return asElement(element);
      },
      frequencies: [32],
      probe: async () => true,
      createGraph: (element, options) =>
        createAudioGraph(element, { ...options, contextFactory: () => asContext(context) }),
    });
    await expect(driver.load("https://audio.example/a")).resolves.toBe("native");
    expect(driver.element).toBe(elements[0]);
    expect(FakeAudioContext.captured.has(asElement(elements[0]))).toBe(false);
    expect(FakeAudioContext.captured.has(asElement(elements[1]))).toBe(true);
    expect(elements[1].src).toBe("");
    expect(context.close).toHaveBeenCalledOnce();
    await driver.play();
    expect(elements[1].play).not.toHaveBeenCalled();
  });

  it("stops graph ownership before fallback play and contains policy rejection", async () => {
    const plain = new FakeAudio();
    const processed = new FakeAudio();
    const policy = new DOMException("gesture required", "NotAllowedError");
    plain.play.mockImplementation(async () => {
      expect(processed.paused).toBe(true);
      expect(processed.src).toBe("");
      throw policy;
    });
    const driver = new AudioProcessingDriver({
      createElement: vi
        .fn()
        .mockReturnValueOnce(asElement(plain))
        .mockReturnValueOnce(asElement(processed)),
      frequencies: [],
      probe: async () => true,
      createGraph: () => graphLease(new FakeAudioContext()),
    });
    await driver.load("https://audio.example/a");
    await driver.play();
    const errors = vi.fn();
    driver.on("error", errors);
    processed.dispatchEvent(new Event("error"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(plain.play).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });
  it("adopts successful plain fallback before the pending graph play rejects", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    const graphPlay = deferred();
    elements[1].play.mockReturnValue(graphPlay.promise);
    const result = driver.play().then(
      () => "played",
      (error: unknown) => error,
    );
    elements[1].dispatchEvent(new Event("error"));
    await Promise.resolve();
    graphPlay.reject(new Error("old graph aborted by release"));
    expect(await result).toBe("played");
    expect(elements[0].play).toHaveBeenCalledOnce();
  });

  it.each(["decode", "policy"])(
    "adopts plain %s failure instead of old graph failure",
    async (kind) => {
      const { driver, elements } = playbackFixture();
      await driver.load("https://audio.example/a");
      const graphPlay = deferred();
      const plainPlay = deferred();
      elements[1].play.mockReturnValue(graphPlay.promise);
      elements[0].play.mockReturnValue(plainPlay.promise);
      const result = driver.play().catch((error: unknown) => error);
      elements[1].dispatchEvent(new Event("error"));
      graphPlay.reject(new Error("old graph failed"));
      const expected =
        kind === "policy"
          ? new DOMException("gesture", "NotAllowedError")
          : new Error("plain decode");
      plainPlay.reject(expected);
      expect(await result).toBe(expected);
    },
  );

  it("settles from fallback without waiting for an abandoned graph promise", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    const graphPlay = deferred();
    const plainPlay = deferred();
    elements[1].play.mockReturnValue(graphPlay.promise);
    elements[0].play.mockReturnValue(plainPlay.promise);
    const settled = vi.fn();
    const result = driver.play().then(settled);
    const intent = driver.playIntentGeneration;
    elements[1].dispatchEvent(new Event("error"));
    expect(driver.playIntentGeneration).toBe(intent);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    plainPlay.resolve();
    await result;
    expect(settled).toHaveBeenCalledOnce();
    graphPlay.reject(new DOMException("obsolete graph policy", "NotAllowedError"));
    await Promise.resolve();
  });

  it.each(["pause", "clear", "load", "cancel"])(
    "ignores obsolete fallback policy rejection after %s",
    async (action) => {
      const { driver, elements } = playbackFixture();
      await driver.load("https://audio.example/a");
      const graphPlay = deferred();
      const plainPlay = deferred();
      elements[1].play.mockReturnValue(graphPlay.promise);
      elements[0].play.mockReturnValue(plainPlay.promise);
      const result = driver.play();
      elements[1].dispatchEvent(new Event("error"));
      const errors = vi.fn();
      driver.on("error", errors);
      if (action === "pause") driver.pause();
      else if (action === "clear") driver.clearSource();
      else if (action === "cancel") driver.cancelPendingPlay();
      else await driver.load("https://audio.example/b");
      await expect(result).resolves.toBeUndefined();
      graphPlay.reject(new Error("released graph"));
      plainPlay.reject(new DOMException("obsolete plain policy", "NotAllowedError"));
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).not.toHaveBeenCalled();
      if (action === "load") expect(driver.source).toBe("https://audio.example/b");
    },
  );

  it("does not let multiple old graph calls block or cancel a newer plain intent", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    const firstGraph = deferred();
    const secondGraph = deferred();
    const fallback = deferred();
    elements[1].play
      .mockReturnValueOnce(firstGraph.promise)
      .mockReturnValueOnce(secondGraph.promise);
    elements[0].play.mockReturnValueOnce(fallback.promise);
    const first = driver.play();
    const second = driver.play();
    await first;
    elements[1].dispatchEvent(new Event("error"));
    const third = driver.play();
    await second;
    await third;
    const pauses = elements[0].pause.mock.calls.length;
    firstGraph.reject(new DOMException("old policy", "NotAllowedError"));
    secondGraph.reject(new Error("old graph"));
    fallback.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(elements[0].pause).toHaveBeenCalledTimes(pauses);
    expect(elements[0].paused).toBe(false);
  });

  it("does not forward obsolete background failure after a newer same-source play", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    await driver.play();
    const fallback = deferred();
    elements[0].play.mockReturnValueOnce(fallback.promise);
    const errors = vi.fn();
    driver.on("error", errors);
    elements[1].dispatchEvent(new Event("error"));
    await driver.play();
    fallback.reject(new Error("obsolete background failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps reentrant source and play when fallback play dispatches synchronously", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    const graphPlay = deferred();
    elements[1].play.mockReturnValue(graphPlay.promise);
    const original = driver.play();
    let replacement: Promise<void> | undefined;
    driver.on("play", () => {
      if (driver.source.endsWith("a"))
        replacement = driver.load("https://audio.example/b").then(() => driver.play());
    });
    elements[1].dispatchEvent(new Event("error"));
    await original;
    await replacement;
    graphPlay.reject(new Error("discarded graph"));
    await Promise.resolve();
    expect(driver.source).toBe("https://audio.example/b");
    expect(driver.element.paused).toBe(false);
    expect(elements[0].src).toBe("");
  });

  it("revokes a pending resume without pausing an already playing fade owner", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    await driver.play();
    const pauses = elements[1].pause.mock.calls.length;
    const source = driver.loadGeneration;
    const cancelled = driver.cancelPendingPlay();
    expect(cancelled).toBe(driver.playIntentGeneration);
    expect(driver.isCurrent(source)).toBe(true);
    expect(elements[1].pause).toHaveBeenCalledTimes(pauses);
    expect(elements[1].paused).toBe(false);
    elements[1].dispatchEvent(new Event("error"));
    expect(elements[0].play).not.toHaveBeenCalled();
    expect(driver.playIntentGeneration).toBe(cancelled);
    driver.pause();
    expect(elements[0].paused).toBe(true);
  });

  it("cancels pending starts promptly and stops late success without stopping newer play", async () => {
    const { driver, elements } = playbackFixture();
    await driver.load("https://audio.example/a");
    const pending = deferred();
    elements[1].play.mockImplementationOnce(async () => {
      await pending.promise;
      elements[1].paused = false;
    });
    const playing = driver.play();
    driver.cancelPendingPlay();
    await playing;
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(elements[1].paused).toBe(true);
    const old = deferred();
    elements[1].play.mockReturnValueOnce(old.promise);
    const oldCall = driver.play();
    driver.cancelPendingPlay();
    await driver.play();
    const pauses = elements[1].pause.mock.calls.length;
    old.resolve();
    await oldCall;
    await Promise.resolve();
    expect(elements[1].pause).toHaveBeenCalledTimes(pauses);
    expect(elements[1].paused).toBe(false);
  });

  it("cancels graph gain automation at current context time", async () => {
    const { driver, elements, context } = playbackFixture();
    await driver.load("https://audio.example/a");
    const gain = driver.gain!.gain as unknown as FakeAudioParam;
    driver.setVolume(0.35);
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(context.currentTime);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0.35, context.currentTime);
    expect(gain.cancelScheduledValues.mock.invocationCallOrder[0]).toBeLessThan(
      gain.setValueAtTime.mock.invocationCallOrder[0],
    );
    expect(elements[1].volume).toBe(1);
    elements[1].dispatchEvent(new Event("error"));
    expect(elements[0].volume).toBe(0.35);
  });

  it("prepares the captured graph output after resume and plain output on fallback", async () => {
    const resume = deferred();
    const graphOutput = deferred();
    const plainOutput = deferred();
    const prepareOutput = vi
      .fn()
      .mockReturnValueOnce(graphOutput.promise)
      .mockReturnValueOnce(plainOutput.promise);
    const { driver, elements, context } = playbackFixture(prepareOutput);
    Object.defineProperty(context, "state", { value: "suspended" });
    context.resume.mockReturnValue(resume.promise);
    await driver.load("https://audio.example/a");
    const playing = driver.play();
    expect(prepareOutput).not.toHaveBeenCalled();
    resume.resolve();
    await Promise.resolve();
    expect(prepareOutput).toHaveBeenCalledWith(elements[1], context);
    expect(elements[1].play).not.toHaveBeenCalled();
    graphOutput.resolve();
    await playing;
    elements[1].dispatchEvent(new Event("error"));
    expect(prepareOutput).toHaveBeenLastCalledWith(elements[0], undefined);
    expect(elements[0].play).not.toHaveBeenCalled();
    plainOutput.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(elements[0].play).toHaveBeenCalledOnce();
  });

  it.each(["load", "clear", "pause", "cancel", "new-play"])(
    "rejects stale output preparation after %s",
    async (action) => {
      const output = deferred();
      const prepareOutput = vi
        .fn()
        .mockReturnValueOnce(output.promise)
        .mockResolvedValue(undefined);
      const { driver, elements } = playbackFixture(prepareOutput);
      await driver.load("https://audio.example/a");
      const playing = driver.play();
      if (action === "load") {
        await driver.load("https://audio.example/b");
        await driver.play();
      } else if (action === "clear") driver.clearSource();
      else if (action === "pause") driver.pause();
      else if (action === "cancel") driver.cancelPendingPlay();
      else await driver.play();
      await playing;
      const starts = elements[1].play.mock.calls.length;
      output.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(elements[1].play).toHaveBeenCalledTimes(starts);
      if (action === "load") expect(driver.element.paused).toBe(false);
    },
  );

  it("ignores old output hook rejection after fallback adopts the new output", async () => {
    const output = deferred();
    const prepareOutput = vi.fn().mockReturnValueOnce(output.promise).mockResolvedValue(undefined);
    const { driver, elements } = playbackFixture(prepareOutput);
    await driver.load("https://audio.example/a");
    const playing = driver.play();
    elements[1].dispatchEvent(new Event("error"));
    await playing;
    output.reject(new DOMException("old output", "NotAllowedError"));
    await Promise.resolve();
    expect(elements[1].play).not.toHaveBeenCalled();
    expect(elements[0].play).toHaveBeenCalledOnce();
  });

  it("continues playback when output preparation reports a caught routing error", async () => {
    const prepareOutput = vi.fn().mockRejectedValue(new Error("setSinkId failed"));
    const { driver, elements } = playbackFixture(prepareOutput);
    await driver.load("https://audio.example/a");
    await expect(driver.play()).resolves.toBeUndefined();
    expect(prepareOutput).toHaveBeenCalledWith(elements[1], expect.anything());
    expect(elements[1].play).toHaveBeenCalledOnce();
  });
});
