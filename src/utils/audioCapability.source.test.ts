import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProcessingDriver, type AudioSourceInfo } from "./audioCapability";

class Source extends EventTarget {
  src = "";
  type = "";
  parent: Media | undefined;
  remove() {
    this.parent?.children.delete(this);
    this.parent = undefined;
  }
}

class Media extends EventTarget {
  private attributes = new Map<string, string>();
  readonly children = new Set<object>();
  readonly ownerDocument = { createElement: () => new Source() };
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  readyState = 1;
  paused = true;
  get src() {
    return this.attributes.get("src") ?? "";
  }
  set src(value: string) {
    this.attributes.set("src", value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  appendChild(source: Source) {
    source.parent = this;
    this.children.add(source);
    return source;
  }
  load = vi.fn(() => {
    this.currentTime = 0;
    this.dispatchEvent(new Event("loadstart"));
  });
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
}

const migu: AudioSourceInfo = { platform: "migu", format: "m4a" };
const drivers: AudioProcessingDriver[] = [];
function fixture(probeResult = false) {
  const elements: Media[] = [];
  const probe = vi.fn(async () => probeResult);
  const driver = new AudioProcessingDriver({
    createElement: () => {
      const element = new Media();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
    frequencies: [],
    probe,
    createGraph: () => {
      throw new Error("graph setup rejected");
    },
  });
  drivers.push(driver);
  const current = () => {
    const element = elements.find((entry) => Object.is(entry, driver.element));
    if (!element) throw new Error("missing active media");
    return element;
  };
  return { driver, elements, probe, current };
}
function sourceOf(element: Media) {
  const sources = [...element.children].filter((child): child is Source => child instanceof Source);
  expect(sources).toHaveLength(1);
  return sources[0];
}

afterEach(() => {
  drivers.splice(0).forEach((driver) => driver.dispose());
});

describe("咪咕 M4A 容器类型加载", () => {
  it("uses a typed source with no parent src, preserving the supplied URL", async () => {
    const { driver, current } = fixture();
    const url = "https://audio.example/wlansst?FN=filename.m4a";
    await driver.load(url, migu);
    const element = current();
    expect(element.getAttribute("src")).toBeNull();
    expect(sourceOf(element)).toMatchObject({ src: url, type: "audio/mp4" });
    expect(element.crossOrigin).toBeNull();
    expect(element.load).toHaveBeenCalled();
    expect(element.play).not.toHaveBeenCalled();
    expect(driver.source).toBe(url);
  });

  it.each([
    { platform: "migu", format: "mp3" },
    { platform: "netease", format: "m4a" },
    { platform: "qq", format: "m4a" },
    { platform: "migu", format: "M4A" },
    undefined,
  ])("keeps ordinary src loading for %j", async (source) => {
    const { driver, current } = fixture();
    const url = "https://audio.example/filename.m4a";
    await driver.load(url, source);
    expect(current().src).toBe(url);
    expect(current().children.size).toBe(0);
    expect(current().crossOrigin).toBeNull();
  });

  it("cleans old source nodes and listeners across typed/ordinary switches, retaining other children", async () => {
    const { driver, current } = fixture();
    const error = vi.fn();
    driver.on("error", error);
    await driver.load("https://audio.example/first", migu);
    const previous = current();
    const track = {};
    previous.children.add(track);
    const first = sourceOf(previous);
    await driver.load("https://audio.example/second", migu);
    expect(previous.children.has(first)).toBe(false);
    expect(previous.children.has(track)).toBe(true);
    expect(sourceOf(current()).src).toBe("https://audio.example/second");
    first.dispatchEvent(new Event("error"));
    expect(error).not.toHaveBeenCalled();
    const second = sourceOf(current());
    const typed = current();
    await driver.load("https://audio.example/third.mp3");
    expect(typed.children.has(second)).toBe(false);
    expect(current().src).toBe("https://audio.example/third.mp3");
    expect(current().children.size).toBe(0);
    second.dispatchEvent(new Event("error"));
    expect(error).not.toHaveBeenCalled();
  });

  it("forwards the source error once when audio.error is absent and clears it with the source", async () => {
    const { driver, current } = fixture();
    const error = vi.fn();
    driver.on("error", error);
    await driver.load("https://audio.example/failing", migu);
    const source = sourceOf(current());
    source.dispatchEvent(new Event("error"));
    source.dispatchEvent(new Event("error"));
    current().dispatchEvent(new Event("error"));
    expect(error).toHaveBeenCalledOnce();
    expect(driver.errorCode).toBe(4);
    driver.clearSource();
    expect(driver.source).toBe("");
    expect(driver.errorCode).toBe(0);
    source.dispatchEvent(new Event("error"));
    expect(error).toHaveBeenCalledOnce();
  });

  it("keeps play/pause, seeking, volume and rate on the current typed element", async () => {
    const { driver, current } = fixture();
    driver.setVolume(0.65);
    driver.setRate(1.25);
    await driver.load("https://audio.example/play", migu);
    const element = current();
    const loadCount = element.load.mock.calls.length;
    await driver.play();
    expect(element.paused).toBe(false);
    driver.seek(17);
    expect(element.currentTime).toBe(17);
    driver.pause();
    expect(element.paused).toBe(true);
    await driver.play();
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(element.volume).toBe(0.65);
    expect(element.playbackRate).toBe(1.25);
    expect(element.load).toHaveBeenCalledTimes(loadCount);
  });

  it("retains the MIME hint if existing graph admission falls back to plain playback", async () => {
    const { driver, current, probe } = fixture(true);
    await driver.load("https://audio.example/play", migu);
    expect(probe).toHaveBeenCalledOnce();
    expect(sourceOf(current())).toMatchObject({ type: "audio/mp4" });
    expect(current().getAttribute("src")).toBeNull();
    expect(current().crossOrigin).toBeNull();
  });

  it("drops a late typed load when an ordinary source replaces its probe", async () => {
    const { driver, current, probe } = fixture();
    let resolve!: (value: boolean) => void;
    probe.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const first = driver.load("https://audio.example/late", migu);
    await Promise.resolve();
    await Promise.resolve();
    const second = driver.load("https://audio.example/current.mp3");
    resolve(false);
    await Promise.all([first, second]);
    expect(current().src).toBe("https://audio.example/current.mp3");
    expect(current().children.size).toBe(0);
  });

  it("AudioManager forwards child-source errors through existing player recovery and preserves preload intent", async () => {
    const elements: Media[] = [];
    vi.stubGlobal("Audio", function () {
      const element = new Media();
      elements.push(element);
      return element;
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("no CORS access")));
    vi.stubGlobal("MediaError", {
      MEDIA_ERR_ABORTED: 1,
      MEDIA_ERR_NETWORK: 2,
      MEDIA_ERR_DECODE: 3,
      MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
    });
    let manager: typeof import("./audioManager").default | undefined;
    try {
      manager = (await import("./audioManager")).default;
      const error = vi.fn();
      manager.on("error", error);
      await manager.play("https://audio.example/migu", { autoPlay: false, source: migu });
      const element = elements.at(-1);
      if (!element) throw new Error("missing media element");
      expect(element.play).not.toHaveBeenCalled();
      await manager.play();
      expect(manager.paused).toBe(false);
      manager.seek(12.5);
      expect(manager.currentTime).toBe(12.5);
      sourceOf(element).dispatchEvent(new Event("error"));
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.objectContaining({ errorCode: 4 }) }),
      );
      expect(manager.src).toBe("https://audio.example/migu");
    } finally {
      manager?.clearSource();
      vi.unstubAllGlobals();
    }
  });
});
