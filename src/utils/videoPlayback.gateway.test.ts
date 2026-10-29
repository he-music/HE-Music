import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayProxyUrl } from "@/platform/gateway";
import { createVideoPlayback, type VideoSource } from "./videoPlayback";

const doubles = vi.hoisted(() => ({
  players: [] as Array<{
    source: { poster?: string; sources: VideoSource[] };
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  streams: [] as Array<{
    loadSource: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    handlers: Map<string, (...args: unknown[]) => void>;
  }>,
  supported: true,
}));

vi.mock("plyr", () => ({
  default: class {
    source = { poster: "", sources: [] as VideoSource[] };
    pause = vi.fn();
    destroy = vi.fn();
    on = vi.fn();
    constructor() {
      doubles.players.push(this);
    }
  },
}));

vi.mock("hls.js", () => ({
  default: class {
    static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
    static isSupported = () => doubles.supported;
    handlers = new Map<string, (...args: unknown[]) => void>();
    levels = [{ height: 720 }, { height: 1080 }, { height: 720 }];
    currentLevel = -1;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    constructor() {
      doubles.streams.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
    }
  },
}));

const remotePoster = "https://images.fixture.invalid/cover.jpg";
const gatewayOrigin = "http://127.0.0.1:45123";
const cleanups: Array<() => void> = [];

function mount(autoplay = false) {
  const media = {
    play: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
  };
  const host = {
    replaceChildren: vi.fn(),
    querySelector: vi.fn(() => media),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => media) });
  const onError = vi.fn();
  const onQualities = vi.fn();
  const playback = createVideoPlayback(
    host as unknown as HTMLElement,
    { autoplay },
    vi.fn(),
    onError,
    onQualities,
  );
  cleanups.push(playback.destroy);
  return { playback, media, host, onError, onQualities };
}

beforeEach(() => {
  doubles.players.length = 0;
  doubles.streams.length = 0;
  doubles.supported = true;
});

afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

describe("videoPlayback 资源消费网关", () => {
  it.each([false, true])("普通视频在 mygo=%s 时派生消费地址并保留原始模型", (mygo) => {
    vi.stubGlobal("window", mygo ? { __HE_MUSIC_GATEWAY_ORIGIN__: gatewayOrigin } : {});
    const { playback } = mount();
    const sources: VideoSource[] = [
      { src: "https://video.fixture.invalid/movie.mp4?quality=720", type: "video/mp4", size: 720 },
      {
        src: "https://video.fixture.invalid/movie.mp4?quality=1080",
        type: "video/mp4",
        size: 1080,
      },
    ];
    const original = structuredClone(sources);
    playback.setSource(sources, "电影", remotePoster);
    expect(sources).toEqual(original);
    expect(doubles.players[0].source).toMatchObject({
      poster: gatewayProxyUrl(remotePoster),
      sources: original.map((source) => ({ ...source, src: gatewayProxyUrl(source.src) })),
    });
    expect(doubles.streams).toHaveLength(0);
  });

  it.each([false, true])("HLS 在 mygo=%s 时保持源格式识别并使用相同网关", (mygo) => {
    vi.stubGlobal("window", mygo ? { __HE_MUSIC_GATEWAY_ORIGIN__: gatewayOrigin } : {});
    const { playback } = mount();
    const source = {
      src: "https://video.fixture.invalid/master.m3u8?token=fixture",
      type: "application/x-mpegURL",
      size: 0,
    };
    playback.setSource([source], "直播", remotePoster);
    expect(doubles.streams).toHaveLength(1);
    expect(doubles.streams[0].loadSource).toHaveBeenCalledWith(gatewayProxyUrl(source.src));
    expect(doubles.players[0].source.sources[0].src).toBe("");
    expect(doubles.players[0].source.poster).toBe(gatewayProxyUrl(remotePoster));
    expect(source.src).toBe("https://video.fixture.invalid/master.m3u8?token=fixture");
  });

  it("不支持 Hls.js 时将 HLS 网关地址交给原生媒体节点", () => {
    doubles.supported = false;
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gatewayOrigin });
    const { playback } = mount();
    const source = {
      src: "https://video.fixture.invalid/native.m3u8",
      type: "application/x-mpegURL",
      size: 0,
    };
    playback.setSource([source], "原生 HLS", remotePoster);
    expect(doubles.streams).toHaveLength(0);
    expect(doubles.players[0].source.sources[0].src).toBe(gatewayProxyUrl(source.src));
  });

  it("换源和卸载后忽略迟到的清单与错误回调", () => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gatewayOrigin });
    const { playback, media, onError, onQualities } = mount(true);
    const source = (name: string): VideoSource[] => [
      { src: `https://video.fixture.invalid/${name}.m3u8`, type: "application/x-mpegURL", size: 0 },
    ];
    playback.setSource(source("old"), "旧视频", remotePoster);
    const old = doubles.streams[0];
    playback.setSource(source("new"), "新视频", remotePoster);
    expect(old.destroy).toHaveBeenCalledOnce();
    onQualities.mockClear();
    old.handlers.get("manifest")?.();
    old.handlers.get("error")?.("error", { fatal: true });
    expect(media.play).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onQualities).not.toHaveBeenCalled();
    const current = doubles.streams[1];
    current.handlers.get("manifest")?.();
    expect(media.play).toHaveBeenCalledOnce();
    expect(onQualities).toHaveBeenCalledWith([720, 1080]);
    playback.destroy();
    playback.destroy();
    current.handlers.get("manifest")?.();
    current.handlers.get("error")?.("error", { fatal: true });
    expect(media.play).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(current.destroy).toHaveBeenCalledOnce();
    expect(doubles.players[0].destroy).toHaveBeenCalledOnce();
    playback.setSource(source("after-unmount"), "已卸载", remotePoster);
    expect(doubles.streams).toHaveLength(2);
  });
});
