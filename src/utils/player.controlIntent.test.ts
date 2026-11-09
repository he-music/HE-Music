import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import type { PlatformMpvPlayback, MpvSnapshot } from "@/platform/mpvPlayback";

import type { ControlCommand, ControlProvider } from "@/platform/controlSession";

interface PlaybackWarning {
  title?: string;
  content?: string;
  positiveText?: string;
  onPositiveClick?: () => unknown;
  onNegativeClick?: () => unknown;
  onClose?: () => unknown;
  onMaskClick?: () => unknown;
  onEsc?: () => unknown;
}

const mocks = vi.hoisted(() => ({
  mygo: true,
  destroyDialog: vi.fn(),
  engine: "web-audio" as "web-audio" | "mpv",
  mpv: undefined as PlatformMpvPlayback | undefined,
  music: {
    playSong: { id: "A", platform: "test", name: "A", path: "", links: [] as SongInfo["links"] },
    songCover: "cover",
    $patch: vi.fn(),
    resetMusicData: vi.fn(),
    radio: { id: "radio", platform: "test", pageIndex: 1, playIndex: 0, list: [] as SongInfo[] },
  },
  status: {
    $patch: vi.fn<(patch: Record<string, unknown>) => void>(),
    playIndex: 0,
    playSongMode: "repeat",
    radioMode: false,
    playStatus: false,
    playLoading: false,
    playVolume: 1,
    playRate: 1,
    currentTime: 0,
    progress: 0,
    lyricIndex: -1,
    duration: 180000,
    playQuality: "128mp3",
    selectedQuality: "128mp3",
    eqEnabled: false,
  },
  data: { playList: [] as SongInfo[], setHistory: vi.fn(), playListOriginal: [] as SongInfo[] },
  url: vi.fn<() => Promise<string>>(),
  sink: vi.fn<(device: string) => Promise<void>>(async () => {}),
  device: vi.fn<() => string | undefined>(() => undefined),
  lyrics: vi.fn(),
  cover: vi.fn(),
  warning: vi.fn<(options: PlaybackWarning) => { destroy(): void }>(),
  ref: { grantToken: "grant", fileId: "B", version: "one", relativePath: "B.mp3" },
  radio: vi.fn(),
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
  useDataStore: () => mocks.data,
  useSettingStore: () => ({
    get playbackEngine() {
      return mocks.engine;
    },
    set playbackEngine(engine) {
      mocks.engine = engine;
    },
    smtcOpen: false,
    showSpectrums: true,
    get playDevice() {
      return mocks.device();
    },
    getFadeTime: 0,
    songLevel: "128mp3",
  }),
}));
vi.mock("@/platform", () => ({
  platform: {
    get mpvPlayback() {
      return mocks.mpv;
    },
  },
}));
vi.mock("./songManager", () => ({
  default: {
    getPlaySongData: () =>
      mocks.status.radioMode
        ? mocks.music.radio.list[mocks.music.radio.playIndex]
        : mocks.data.playList[mocks.status.playIndex],
    getPlayerInfoObj: () => ({ name: mocks.music.playSong.name, artist: "Artist" }),
    getOnlineSource: async (_id: string, _platform: string, link?: { format: string }) => ({
      url: await mocks.url(),
      format: link?.format ?? "mp3",
    }),
    getCoverColor: mocks.cover,
  },
}));
vi.mock("./lyricManager", () => ({ default: { handleLyric: mocks.lyrics } }));
vi.mock("./env", () => ({
  isElectron: false,
  get isMygo() {
    return mocks.mygo;
  },
  hasNativeSystemMedia: true,
}));
vi.mock("./helper", () => ({ shuffleArray: (items: unknown[]) => items }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("@/api/radio", () => ({ listRadioSongs: mocks.radio }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/platform/gateway", () => ({
  gatewayProxyUrl: (url: string) => url,
  isMygoGatewayResourceUrl: () => false,
}));
vi.mock("@/platform/localResource", () => ({
  localResourceURL: () => "http://127.0.0.1:1234/session/__local/audio?path=B.mp3",
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: () => ({ path: `/fixture/${mocks.ref.fileId}.mp3`, ref: mocks.ref }),
  localFilesSession: { value: { entries: { value: [{ ref: mocks.ref }] } } },
}));

class InertMedia extends EventTarget {
  src = "";
  paused = true;
  currentTime = 0;
  duration = 180;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  setSinkId = mocks.sink;
  load() {}
  removeAttribute() {
    this.src = "";
  }
  play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const song = (id: string, path = ""): SongInfo => ({
  id,
  name: id,
  platform: "test",
  path,
  subtitle: "",
  duration: 180000,
  mv_id: "",
  album: "Album",
  artists: "Artist",
  cover: "cover",
  links: [{ name: "128mp3", quality: 128, format: "mp3", size: "1", url: "synthetic" }],
});
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const elements: InertMedia[] = [];
const stops: Array<() => Promise<void>> = [];
let player: ReturnType<typeof import("./player").usePlayer>;
let manager: typeof import("./audioManager").default;
let retry: (() => unknown) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.mygo = true;
  mocks.engine = "web-audio";
  mocks.mpv = undefined;
  mocks.music = reactive({
    playSong: { ...song("A"), path: "" },
    songCover: "cover",
    $patch: vi.fn(),
    resetMusicData: vi.fn(),
    radio: { id: "radio", platform: "test", pageIndex: 1, playIndex: 0, list: [] as SongInfo[] },
  });
  Object.assign(mocks.status, {
    playIndex: 0,
    playSongMode: "repeat",
    radioMode: false,
    playStatus: false,
    playLoading: false,
    playQuality: "128mp3",
    selectedQuality: "128mp3",
  });
  mocks.status.$patch.mockImplementation((patch) => {
    Object.assign(mocks.status, patch);
  });
  mocks.data.playList = [song("A"), song("B")];
  mocks.ref.fileId = "B";
  mocks.radio.mockReset();
  mocks.sink.mockReset().mockResolvedValue(undefined);
  mocks.device.mockReset().mockReturnValue(undefined);
  mocks.url.mockReset().mockResolvedValue("https://synthetic.invalid/current");

  mocks.warning.mockImplementation((options) => {
    retry = options.onNegativeClick;
    return { destroy: mocks.destroyDialog };
  });
  vi.stubGlobal("window", {
    document: { title: "" },
    location: { protocol: "https:" },
    $message: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
    $dialog: { warning: mocks.warning },
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });
  vi.stubGlobal("Audio", function () {
    const element = new InertMedia();
    elements.push(element);
    return element;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  manager = (await import("./audioManager")).default;
  player = (await import("./player")).usePlayer();
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await manager.clearSource();
  elements.length = 0;
  retry = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function expectPaused() {
  expect(manager.paused).toBe(true);
  expect(mocks.status.playStatus).toBe(false);
  expect(elements.every((element) => element.paused)).toBe(true);
}
async function shell(generation: number) {
  let emit: (command: ControlCommand) => void = () => {};
  const provider: ControlProvider = {
    start: vi.fn(async () => ({ generation, port: 25666 })),
    receipt: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: (listener) => {
      emit = listener;
      return () => {};
    },
  };
  const control = (await import("@/composables/shellControl")).createShellControlSession(provider);
  if (!control) throw new Error("Missing control shell");
  await control.start();
  stops.push(() => control.dispose());
  let requestId = 0;
  return {
    control,
    provider,
    emit: (action: string) => emit({ generation, requestId: ++requestId, action }),
  };
}

describe("Player 切换输出时的音质选择", () => {
  beforeEach(() => {
    vi.spyOn(manager, "setEngine").mockResolvedValue(undefined);
    vi.spyOn(manager, "play").mockResolvedValue(undefined);
    mocks.data.playList[0].links.push({
      name: "flac",
      quality: 1000,
      format: "flac",
      size: "1",
      url: "synthetic-flac",
    });
  });

  it.each(["mpv", "web-audio"] as const)(
    "切换到 %s 时保留当前音质，不被偏好覆盖",
    async (engine) => {
      mocks.engine = engine === "mpv" ? "web-audio" : "mpv";
      mocks.status.playQuality = "flac";
      mocks.status.selectedQuality = "flac";

      await player.changePlaybackOutput(engine);

      expect(mocks.engine).toBe(engine);
      expect(mocks.status.playQuality).toBe("flac");
      expect(mocks.status.selectedQuality).toBe("flac");
      expect(mocks.url).toHaveBeenCalledOnce();
      expect(manager.play).toHaveBeenCalledWith(
        "https://synthetic.invalid/current",
        expect.objectContaining({ source: expect.objectContaining({ format: "flac" }) }),
      );
      expect(window.$message.success).not.toHaveBeenCalled();
    },
  );

  it("目标内核不支持当前音质时，使用现有偏好回退", async () => {
    mocks.engine = "mpv";
    mocks.status.playQuality = "dsd";
    mocks.status.selectedQuality = "dsd";
    mocks.data.playList[0].links.push({
      name: "dsd",
      quality: 2000,
      format: "dsf",
      size: "1",
      url: "synthetic-dsd",
    });

    await player.changePlaybackOutput("web-audio");

    expect(mocks.status.playQuality).toBe("128mp3");
    expect(mocks.status.selectedQuality).toBe("dsd");
    expect(manager.play).toHaveBeenCalledWith(
      "https://synthetic.invalid/current",
      expect.not.objectContaining({ source: expect.anything() }),
    );
    expect(window.$message.success).not.toHaveBeenCalled();
  });

  it("正常加载歌曲仍使用音质偏好", async () => {
    mocks.status.playQuality = "flac";
    mocks.status.selectedQuality = "flac";

    await player.initPlayer();

    expect(mocks.status.playQuality).toBe("128mp3");
  });

  it("手动切换音质仍显示操作反馈", async () => {
    await player.changeQuality("flac");

    expect(mocks.status.playQuality).toBe("flac");
    expect(window.$message.success).toHaveBeenCalledWith("message.change_quality_to");
  });
});

function mpvProvider(): PlatformMpvPlayback {
  let snapshot: MpvSnapshot = {
    lifecycle: 1,
    session: 0,
    sequence: 1,
    state: "idle",
    position: 0,
    duration: 180,
    rate: 1,
    volume: 1,
    source: "",
    device: "auto",
    error: null,
  };
  const update = (patch: Partial<MpvSnapshot>) =>
    (snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 });
  return {
    capabilities: {
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: false,
      supportsSpectrum: false,
      supportsFade: false,
    },
    initialize: vi.fn(async () => snapshot),
    load: vi.fn(async (_lifecycle, request) =>
      update({
        session: snapshot.session + 1,
        source: request.url,
        position: request.start,
        state: "paused",
      }),
    ),
    play: vi.fn(async () => {
      update({ state: "playing" });
    }),
    pause: vi.fn(async () => {
      update({ state: "paused" });
    }),
    clearSource: vi.fn(async () => update({ source: "", state: "idle", position: 0 })),
    stop: vi.fn(async () => update({ source: "", state: "idle", position: 0 })),
    seek: vi.fn(async (_lifecycle, _session, position) => {
      update({ position });
    }),
    setVolume: vi.fn(async () => {}),
    setRate: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async () => {}),
    getOutputDevices: vi.fn(async () => []),
    snapshot: vi.fn(async () => snapshot),
    destroy: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    teardown: vi.fn(),
  };
}

function currentMedia() {
  const element = elements.at(-1);
  if (!element) throw new Error("Missing media element");
  return element;
}

function failMedia(code: number) {
  const element = currentMedia();
  element.error = { code };
  element.dispatchEvent(new Event("error"));
}

function mpvWarning() {
  const options = mocks.warning.mock.calls.find(
    ([options]) => options.title === "mygo.audio.compatibility_title",
  )?.[0];
  if (!options) throw new Error("Missing mpv recovery dialog");
  return options;
}

describe("Web Audio 格式兼容引导", () => {
  beforeEach(() => {
    mocks.mpv = mpvProvider();
  });

  it.each([3, 4])("媒体错误 %s 提供 mpv 重试，保留歌曲、音质和进度", async (code) => {
    await player.initPlayer(true);
    currentMedia().currentTime = 12;
    const next = vi.spyOn(player, "nextOrPrev");

    failMedia(code);
    failMedia(code);

    expect(mocks.warning).toHaveBeenCalledOnce();
    expectPaused();
    expect(mocks.status.playLoading).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.engine).toBe("web-audio");

    await mpvWarning().onPositiveClick?.();

    expect(manager.engineId).toBe("mpv");
    expect(mocks.engine).toBe("mpv");
    expect(mocks.music.playSong.id).toBe("A");
    expect(mocks.mpv?.load).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ format: "mp3", start: 12 }),
    );
    expect(mocks.mpv?.play).toHaveBeenCalledOnce();
    expect(mocks.status.playQuality).toBe("128mp3");
    expect(window.$message.success).not.toHaveBeenCalled();
  });

  it("没有媒体错误事件的 NotSupportedError 也提供引导", async () => {
    vi.spyOn(manager, "play").mockRejectedValueOnce(
      new DOMException("Unsupported", "NotSupportedError"),
    );
    const next = vi.spyOn(player, "nextOrPrev");

    await player.initPlayer();

    expect(mpvWarning().positiveText).toBe("mygo.audio.switch_to_mpv");
    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(mocks.status.playLoading).toBe(false);
    expect(window.$message.error).not.toHaveBeenCalled();
  });

  it("HTTP 排查提示优先，媒体事件和播放拒绝不产生两个提示", async () => {
    mocks.url.mockResolvedValueOnce("http://synthetic.invalid/current");
    vi.spyOn(manager, "play").mockImplementationOnce(async () => {
      failMedia(4);
      throw new DOMException("Unsupported", "NotSupportedError");
    });

    await player.initPlayer();

    expect(mocks.warning).toHaveBeenCalledOnce();
    expect(mocks.warning.mock.calls[0][0].title).toBe("音源 HTTPS 访问失败排查");
  });

  it.each(["onNegativeClick", "onClose", "onMaskClick", "onEsc"] as const)(
    "%s 关闭后保持停止，重复错误不再次提示",
    async (action) => {
      await player.initPlayer();
      failMedia(4);
      mpvWarning()[action]?.();
      failMedia(4);
      expectPaused();
      expect(mocks.engine).toBe("web-audio");
      expect(mocks.warning).toHaveBeenCalledOnce();
    },
  );

  it("切换歌曲关闭提示，旧提示不能再切换引擎", async () => {
    await player.initPlayer();
    failMedia(4);
    const old = mpvWarning();
    await player.nextOrPrev("next");
    expect(mocks.destroyDialog).toHaveBeenCalledOnce();
    await old.onPositiveClick?.();
    expect(mocks.engine).toBe("web-audio");
    expect(mocks.music.playSong.id).toBe("B");
    expect(mocks.mpv?.initialize).not.toHaveBeenCalled();
  });

  it.each(["pause", "preload", "owner"])(
    "%s 撤销自动播放后，切换到 mpv 仍保持暂停",
    async (reason) => {
      let owner = true;
      await player.initPlayer(
        reason !== "preload",
        0,
        "",
        reason === "owner" ? () => owner : undefined,
      );
      failMedia(4);
      if (reason === "pause") await player.pause();
      else if (reason === "owner") owner = false;
      await mpvWarning().onPositiveClick?.();
      expect(manager.engineId).toBe("mpv");
      expect(mocks.mpv?.load).toHaveBeenCalledOnce();
      expect(mocks.mpv?.play).not.toHaveBeenCalled();
      expect(manager.paused).toBe(true);
    },
  );

  it("mpv 初始化失败时给出反馈并保持停止", async () => {
    await player.initPlayer();
    failMedia(3);
    const provider = mocks.mpv;
    if (!provider) throw new Error("Missing mpv provider");
    vi.mocked(provider.initialize).mockRejectedValueOnce(new Error("mpv library missing"));
    await mpvWarning().onPositiveClick?.();
    expect(mocks.engine).toBe("mpv");
    expect(mocks.status.playStatus).toBe(false);
    expect(mocks.status.playLoading).toBe(false);
    expect(window.$message.error).toHaveBeenCalledWith("mygo.audio.engine_change_failed");
  });

  it.each([1, 2])("中止或网络错误 %s 不引导切换 mpv", async (code) => {
    await player.initPlayer();
    failMedia(code);
    expect(mocks.warning).not.toHaveBeenCalled();
    await flush();
  });

  it("网页端不提供 mpv 引导", async () => {
    mocks.mygo = false;
    await player.initPlayer();
    failMedia(3);
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it.each(["device", "engine"] as const)("%s 错误不引导切换 mpv", async (kind) => {
    await player.initPlayer();
    vi.spyOn(manager, "error", "get").mockReturnValue({ kind, message: "Unavailable" });
    failMedia(4);
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(window.$message.error).toHaveBeenCalled();
  });

  it("已使用 mpv 时不再提供切换引导", async () => {
    mocks.engine = "mpv";
    vi.spyOn(manager, "play").mockRejectedValueOnce(
      new DOMException("Unsupported", "NotSupportedError"),
    );
    await player.initPlayer();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(window.$message.error).toHaveBeenCalledWith("message.song_play_fail");
  });

  it("自动播放权限错误不引导切换 mpv", async () => {
    vi.spyOn(manager, "play").mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await player.initPlayer();
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(window.$message.error).toHaveBeenCalledWith("message.song_play_fail");
  });
});

describe("real Player + MpvPlaybackEngine errors", () => {
  it.each(["local-load", "online-load", "online-url", "online-empty"])(
    "%s 拒绝且没有 error 事件时停止并保留当前歌曲",
    async (failure) => {
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
      const next = () => (snapshot = { ...snapshot, sequence: snapshot.sequence + 1 });
      const provider: PlatformMpvPlayback = {
        capabilities: {
          supportsRate: true,
          supportsSinkId: true,
          supportsEqualizer: false,
          supportsSpectrum: false,
          supportsFade: false,
        },
        initialize: vi.fn(async () => snapshot),
        load: vi.fn(async () => {
          throw new Error("provider load rejected without native event");
        }),
        play: vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        clearSource: vi.fn(async () => next()),
        stop: vi.fn(async () => next()),
        seek: vi.fn(async () => {}),
        setVolume: vi.fn(async () => {}),
        setRate: vi.fn(async () => {}),
        setOutputDevice: vi.fn(async () => {}),
        getOutputDevices: vi.fn(async () => []),
        snapshot: vi.fn(async () => snapshot),
        destroy: vi.fn(async () => {}),
        onEvent: vi.fn(() => () => {}),
        teardown: vi.fn(),
      };
      mocks.engine = "mpv";
      mocks.mpv = provider;
      if (failure === "local-load") {
        mocks.data.playList[0] = song("A", "/fixture/A.mp3");
        mocks.ref.fileId = "A";
      }
      if (failure === "online-url") mocks.url.mockRejectedValueOnce(new Error("URL failed"));
      if (failure === "online-empty") mocks.url.mockResolvedValueOnce("");
      const nextOrPrev = vi.spyOn(player, "nextOrPrev");
      mocks.status.playStatus = true;
      await player.initPlayer();
      expect(manager.engineId).toBe("mpv");
      expect(mocks.data.playList).toHaveLength(2);
      expect(mocks.status.playIndex).toBe(0);
      expect(mocks.music.playSong.id).toBe("A");
      expect(nextOrPrev).not.toHaveBeenCalled();
      expect(manager.src).toBe("");
      expect(manager.paused).toBe(true);
      expect(mocks.status.playStatus).toBe(false);
      expect(mocks.status.playLoading).toBe(false);
      expect(provider.play).not.toHaveBeenCalled();
      expect(window.$message.error).toHaveBeenCalledWith("message.song_play_fail");
      expect(provider.load).toHaveBeenCalledTimes(
        failure === "online-url" || failure === "online-empty" ? 0 : 1,
      );
    },
  );
});

describe("real Player HTTP control autoplay intent", () => {
  it.each(["next", "prev"] as const)(
    "%s → pause before URL resolution keeps B preloaded, then explicit play succeeds",
    async (direction) => {
      if (direction === "prev") {
        mocks.data.playList.reverse();
        mocks.status.playIndex = 1;
      }
      const url = deferred<string>();
      mocks.url.mockReturnValueOnce(url.promise);
      const control = await shell(1);
      control.emit(direction);
      await flush();
      expect(mocks.music.playSong.id).toBe("B");
      expect(mocks.url).toHaveBeenCalledOnce();
      control.emit("pause");
      await flush();
      expect(control.provider.receipt).toHaveBeenCalledWith(1, 2, true);
      expectPaused();
      url.resolve("https://synthetic.invalid/B");
      await flush();
      expect(manager.src).toBe("https://synthetic.invalid/B");
      expectPaused();
      expect(mocks.data.setHistory).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "B" }),
      );
      expect(mocks.lyrics).toHaveBeenCalledExactlyOnceWith("B", "test", "");
      control.emit("play");
      await flush();
      expect(manager.paused).toBe(false);
      expect(mocks.status.playStatus).toBe(true);
    },
  );

  it("rejects stale A/B/A URL results while retaining the final A preload", async () => {
    const oldA = deferred<string>(),
      b = deferred<string>(),
      newA = deferred<string>();
    mocks.url
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(newA.promise);
    const first = player.initPlayer();
    const second = player.nextOrPrev("next");
    const third = player.nextOrPrev("prev");
    await player.pause();
    oldA.resolve("https://synthetic.invalid/oldA");
    b.resolve("https://synthetic.invalid/B");
    await Promise.all([first, second]);
    expect(mocks.data.setHistory).not.toHaveBeenCalled();
    newA.resolve("https://synthetic.invalid/newA");
    await third;
    expect(manager.src).toBe("https://synthetic.invalid/newA");
    expectPaused();
    expect(mocks.data.setHistory).toHaveBeenCalledTimes(1);
    await player.play();
    expect(manager.paused).toBe(false);
  });

  it("revokes an old shell's pending autoplay without discarding B, and the new owner can play", async () => {
    const url = deferred<string>();
    mocks.url.mockReturnValueOnce(url.promise);
    const old = await shell(1);
    old.emit("next");
    await flush();
    await old.control.dispose();
    const current = await shell(2);
    old.emit("play");
    url.resolve("https://synthetic.invalid/B");
    await flush();
    expect(manager.src).toBe("https://synthetic.invalid/B");
    expectPaused();
    expect(old.provider.receipt).not.toHaveBeenCalled();
    current.emit("play");
    await flush();
    expect(manager.paused).toBe(false);
  });

  it("does not let old-owner initialization overwrite a newer owner's source or metadata", async () => {
    const b = deferred<string>(),
      a = deferred<string>();
    mocks.url.mockReturnValueOnce(b.promise).mockReturnValueOnce(a.promise);
    const old = await shell(1);
    old.emit("next");
    await flush();
    await old.control.dispose();
    const current = await shell(2);
    current.emit("prev");
    await flush();
    b.resolve("https://synthetic.invalid/oldB");
    await flush();
    expect(mocks.data.setHistory).not.toHaveBeenCalled();
    a.resolve("https://synthetic.invalid/newA");
    await flush();
    expect(manager.src).toBe("https://synthetic.invalid/newA");
    expect(manager.paused).toBe(false);
    expect(mocks.data.setHistory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "A" }),
    );
  });

  it("keeps pause(false) semantics and metadata-blocked source authorization", async () => {
    const url = deferred<string>();
    mocks.url.mockReturnValueOnce(url.promise);
    const loading = player.nextOrPrev("next");
    await player.pause(false);
    url.resolve("https://synthetic.invalid/B");
    await loading;
    expect(manager.paused).toBe(false);
    // Metadata blocking clears the local source and its pending autoplay;
    // release alone must not resurrect the revoked source or pending autoplay.
    mocks.data.playList[0] = song("A", "A.mp3");
    mocks.ref.fileId = "A";
    await player.nextOrPrev("prev");
    const release = (await import("@/platform/localAudioSession")).blockLocalAudio();
    expectPaused();
    expect(manager.src).toBe("");
    release();
    await flush();
    expect(manager.src).toBe("");
    expectPaused();
    await player.initPlayer(false);
    expectPaused();
    await player.play();
    expect(manager.paused).toBe(false);
  });

  it("a pause or owner revoke during AudioManager's deferred source probe still blocks autoplay", async () => {
    const probe = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(probe.promise);
    const loading = player.initPlayer();
    await flush();
    await player.pause();
    probe.resolve(new Response(null, { status: 404 }));
    await loading;
    expect(manager.src).toBe("https://synthetic.invalid/current");
    expectPaused();
    const nextProbe = deferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(nextProbe.promise);
    let currentOwner = true;
    const next = player.nextOrPrev("next", true, false, () => currentOwner);
    await flush();
    currentOwner = false;
    nextProbe.resolve(new Response(null, { status: 404 }));
    await next;
    expectPaused();
  });

  it.each(["pause", "owner"])(
    "preserves %s fence through HTTPS retry after an audio error",
    async (reason) => {
      mocks.url.mockResolvedValueOnce("http://synthetic.invalid/B");
      let owner = true;
      await player.nextOrPrev("next", true, false, () => owner);
      const current = elements.find((element) => element.src === manager.src);
      if (!current) throw new Error("No current media");
      current.error = { code: 4 };
      current.dispatchEvent(new Event("error"));
      expect(mocks.warning).toHaveBeenCalledOnce();
      if (reason === "pause") await player.pause();
      else owner = false;
      retry?.();
      await flush();
      expect(manager.src).toBe("https://synthetic.invalid/B");
      expectPaused();
      await player.play();
      expect(manager.paused).toBe(false);
    },
  );

  it.each([2, 3])(
    "web error %s retries preserve pause rather than restore old autoplay",
    async (code) => {
      mocks.mygo = false;
      await player.initPlayer();
      await player.pause();
      const url = deferred<string>();
      mocks.url.mockReturnValueOnce(url.promise);
      const current = elements.find((element) => element.src === manager.src);
      if (!current) throw new Error("No current media");
      current.error = { code };
      current.dispatchEvent(new Event("error"));
      await flush();
      expect(mocks.url).toHaveBeenCalledTimes(2);
      url.resolve("https://synthetic.invalid/retry");
      await flush();
      expect(manager.src).toBe("https://synthetic.invalid/retry");
      expectPaused();
      await player.play();
      expect(manager.paused).toBe(false);
    },
  );
  it.each(["pause", "owner", "internal-pause"])(
    "preserves %s while a radio next request is deferred",
    async (reason) => {
      mocks.status.radioMode = true;
      mocks.music.radio.list = [song("A")];
      const radio = deferred<{ list: SongInfo[]; page_index: number }>();
      mocks.radio.mockReturnValueOnce(radio.promise);
      let owner = true;
      const loading = player.nextOrPrev("next", true, false, () => owner);
      await flush();
      if (reason === "pause") await player.pause();
      else if (reason === "owner") owner = false;
      else await player.pause(false);
      radio.resolve({ list: [song("B")], page_index: 2 });
      await loading;
      expect(mocks.music.playSong.id).toBe("B");
      expect(manager.src).toBe("https://synthetic.invalid/current");
      if (reason === "internal-pause") expect(manager.paused).toBe(false);
      else expectPaused();
      await player.play();
      expect(manager.paused).toBe(false);
    },
  );
  it("restores the configured output when spectrum display is enabled", async () => {
    mocks.device.mockReturnValue("saved-speakers");
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audiooutput", deviceId: "saved-speakers", label: "Saved" },
        ],
      },
    });
    await player.nextOrPrev("next");
    expect(mocks.sink).toHaveBeenCalledWith("saved-speakers");
    expect(manager.paused).toBe(false);
  });
  it("cancels an old owner's deferred real prepareOutput without losing the source", async () => {
    const sink = deferred<void>();
    mocks.sink.mockReturnValueOnce(sink.promise);
    const routing = manager.setSinkId("synthetic-output");
    const old = await shell(1);
    old.emit("next");
    await flush();
    expect(manager.src).toBe("https://synthetic.invalid/current");
    expect(mocks.sink).toHaveBeenCalledWith("synthetic-output");
    expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
    await old.control.dispose();
    await flush();
    expectPaused();
    sink.resolve();
    await routing;
    await flush();
    expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
    expect(manager.src).toBe("https://synthetic.invalid/current");
    expectPaused();
    const current = await shell(2);
    current.emit("play");
    await flush();
    expect(manager.paused).toBe(false);
  });

  it("does not pause already playing audio when its old shell is disposed", async () => {
    const old = await shell(1);
    old.emit("next");
    await flush();
    expect(manager.paused).toBe(false);
    const pauses = elements.reduce((sum, element) => sum + element.pause.mock.calls.length, 0);
    await old.control.dispose();
    await flush();
    expect(manager.paused).toBe(false);
    expect(elements.reduce((sum, element) => sum + element.pause.mock.calls.length, 0)).toBe(
      pauses,
    );
  });

  it("does not cancel the new owner's current source on late old-shell disposal", async () => {
    const old = await shell(1);
    old.emit("next");
    await flush();
    const current = await shell(2);
    current.emit("prev");
    await flush();
    expect(mocks.music.playSong.id).toBe("A");
    expect(manager.paused).toBe(false);
    await old.control.dispose();
    await flush();
    expect(mocks.music.playSong.id).toBe("A");
    expect(manager.paused).toBe(false);
  });

  it("does not cancel a later explicit user play while output setup is still pending", async () => {
    const sink = deferred<void>();
    mocks.sink.mockReturnValueOnce(sink.promise);
    const routing = manager.setSinkId("synthetic-output");
    const old = await shell(1);
    old.emit("next");
    await flush();
    const explicit = player.play();
    await flush();
    await old.control.dispose();
    sink.resolve();
    await routing;
    await explicit;
    await flush();
    expect(manager.paused).toBe(false);
  });
  it("does not cancel a new owner's pending prepareOutput on late old-shell disposal", async () => {
    const sink = deferred<void>();
    mocks.sink.mockReturnValue(sink.promise);
    mocks.url
      .mockResolvedValueOnce("https://synthetic.invalid/B")
      .mockResolvedValueOnce("https://synthetic.invalid/A");
    const routing = manager.setSinkId("synthetic-output");
    const old = await shell(1);
    old.emit("next");
    await flush();
    const current = await shell(2);
    current.emit("prev");
    await flush();
    expect(manager.src).toBe("https://synthetic.invalid/A");
    expectPaused();
    const pauses = elements.reduce((sum, element) => sum + element.pause.mock.calls.length, 0);
    await old.control.dispose();
    expect(elements.reduce((sum, element) => sum + element.pause.mock.calls.length, 0)).toBe(
      pauses,
    );
    sink.resolve();
    await routing;
    await flush();
    expect(manager.src).toBe("https://synthetic.invalid/A");
    expect(manager.paused).toBe(false);
    expect(
      elements
        .filter((element) => element.play.mock.calls.length > 0)
        .map((element) => element.src),
    ).toEqual(["https://synthetic.invalid/A"]);
  });
  it.each(["old-first", "new-first"])(
    "only commits the new owner's deferred radio result (%s)",
    async (order) => {
      mocks.status.radioMode = true;
      mocks.music.radio.list = [song("A")];
      const oldResult = deferred<{ list: SongInfo[]; page_index: number }>();
      const newResult = deferred<{ list: SongInfo[]; page_index: number }>();
      mocks.radio.mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(newResult.promise);
      const old = await shell(1);
      old.emit("next");
      await flush();
      await old.control.dispose();
      const current = await shell(2);
      current.emit("next");
      await flush();
      expect(mocks.radio).toHaveBeenCalledTimes(2);
      const oldData = { list: [song("old-radio")], page_index: 8 };
      const newData = { list: [song("new-radio")], page_index: 3 };
      if (order === "old-first") {
        oldResult.resolve(oldData);
        await flush();
        expect(mocks.music.radio.list.map((entry) => entry.id)).toEqual(["A"]);
        expect(mocks.music.playSong.id).toBe("A");
        expect(mocks.music.radio.pageIndex).toBe(1);
        expect(mocks.status.$patch).not.toHaveBeenCalled();
        expect(mocks.lyrics).not.toHaveBeenCalled();
        expect(mocks.cover).not.toHaveBeenCalled();
        expect(mocks.url).not.toHaveBeenCalled();
        expect(mocks.data.setHistory).not.toHaveBeenCalled();
        expect(mocks.music.resetMusicData).not.toHaveBeenCalled();
        expect(mocks.status.playLoading).toBe(true);
        newResult.resolve(newData);
        await flush();
      } else {
        newResult.resolve(newData);
        await flush();
        oldResult.resolve(oldData);
        await flush();
      }
      expect(mocks.music.radio.list.map((entry) => entry.id)).toEqual(["new-radio"]);
      expect(mocks.music.radio.pageIndex).toBe(3);
      expect(mocks.music.radio.playIndex).toBe(0);
      expect(mocks.music.playSong.id).toBe("new-radio");
      expect(manager.paused).toBe(false);
      expect(mocks.status.playStatus).toBe(true);
      expect(mocks.music.resetMusicData).toHaveBeenCalledOnce();
      expect(mocks.url).toHaveBeenCalledOnce();
      expect(mocks.lyrics).toHaveBeenCalledExactlyOnceWith("new-radio", "test", "");
      expect(mocks.data.setHistory).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "new-radio" }),
      );
      expect(old.provider.receipt).not.toHaveBeenCalled();
      expect(current.provider.receipt).toHaveBeenCalledWith(2, 1, true);
    },
  );

  it.each(["init", "next-source", "play-paused", "play-playing"])(
    "a newer %s operation supersedes a deferred radio result",
    async (replacement) => {
      if (replacement.startsWith("play")) {
        await player.initPlayer(replacement === "play-playing");
        mocks.url.mockClear();
        mocks.data.setHistory.mockClear();
        mocks.lyrics.mockClear();
      }
      mocks.status.radioMode = true;
      mocks.music.radio.list = [song("A")];
      const result = deferred<{ list: SongInfo[]; page_index: number }>();
      mocks.radio.mockReturnValueOnce(result.promise);
      const loading = player.nextOrPrev("next");
      await flush();
      if (replacement === "init") {
        mocks.status.radioMode = false;
        await player.initPlayer();
      } else if (replacement === "next-source") {
        mocks.status.radioMode = false;
        await player.nextOrPrev("next");
      } else await player.play();
      const expected = mocks.music.playSong.id;
      const history = mocks.data.setHistory.mock.calls.length;
      const lyrics = mocks.lyrics.mock.calls.length;
      const urls = mocks.url.mock.calls.length;
      const resets = mocks.music.resetMusicData.mock.calls.length;
      result.resolve({ list: [song("stale-radio")], page_index: 9 });
      await loading;
      expect(mocks.music.radio.list.map((entry) => entry.id)).toEqual(["A"]);
      expect(mocks.music.playSong.id).toBe(expected);
      expect(mocks.data.setHistory).toHaveBeenCalledTimes(history);
      expect(mocks.lyrics).toHaveBeenCalledTimes(lyrics);
      expect(mocks.url).toHaveBeenCalledTimes(urls);
      expect(mocks.music.resetMusicData).toHaveBeenCalledTimes(resets);
      expect(manager.paused).toBe(false);
      expect(mocks.status.playStatus).toBe(true);
    },
  );
  it("rechecks the radio token if a synchronous reset subscriber starts its successor", async () => {
    mocks.status.radioMode = true;
    mocks.music.radio.list = [song("A")];
    const first = deferred<{ list: SongInfo[]; page_index: number }>();
    const second = deferred<{ list: SongInfo[]; page_index: number }>();
    mocks.radio.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldLoading = player.nextOrPrev("next");
    let successor: Promise<void> = Promise.resolve();
    mocks.status.$patch.mockImplementationOnce((patch) => {
      Object.assign(mocks.status, patch);
      successor = player.nextOrPrev("next");
    });
    first.resolve({ list: [song("first")], page_index: 2 });
    await oldLoading;
    expect(mocks.radio).toHaveBeenCalledTimes(2);
    expect(mocks.music.resetMusicData).not.toHaveBeenCalled();
    expect(mocks.url).not.toHaveBeenCalled();
    second.resolve({ list: [song("successor")], page_index: 3 });
    await successor;
    expect(mocks.music.playSong.id).toBe("successor");
    expect(mocks.url).toHaveBeenCalledOnce();
    expect(mocks.data.setHistory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "successor" }),
    );
    expect(manager.paused).toBe(false);
  });
  it("an explicit play on already playing audio releases the superseded radio owner's retry intent", async () => {
    let owner = true;
    const canAutoPlay = () => owner;
    await player.initPlayer(true, 0, "", canAutoPlay);
    mocks.status.radioMode = true;
    mocks.music.radio.list = [song("A")];
    const result = deferred<{ list: SongInfo[]; page_index: number }>();
    mocks.radio.mockReturnValueOnce(result.promise);
    const loading = player.nextOrPrev("next", true, false, canAutoPlay);
    await flush();
    await player.play();
    owner = false;
    player.cancelPendingAutoplay(canAutoPlay);
    result.resolve({ list: [song("stale")], page_index: 9 });
    await loading;
    const current = elements.find((element) => element.src === manager.src);
    if (!current) throw new Error("No current media");
    current.error = { code: 2 };
    current.dispatchEvent(new Event("error"));
    await flush();
    expect(mocks.music.playSong.id).toBe("A");
    expect(mocks.music.radio.list.map((entry) => entry.id)).toEqual(["A"]);
    expect(manager.paused).toBe(false);
    expect(mocks.status.playStatus).toBe(true);
  });
  async function pausedOutputSetup() {
    await player.initPlayer(false);
    const src = manager.src;
    const sink = deferred<void>();
    mocks.sink.mockReturnValueOnce(sink.promise);
    const routing = manager.setSinkId("synthetic-resume-output");
    return { src, sink, routing };
  }

  it.each(["play", "toggle"])(
    "HTTP %s cannot resume after its owner is disposed during real prepareOutput",
    async (action) => {
      const { src, sink, routing } = await pausedOutputSetup();
      const old = await shell(1);
      old.emit(action);
      await flush();
      expect(mocks.sink).toHaveBeenCalledWith("synthetic-resume-output");
      expect(old.provider.receipt).not.toHaveBeenCalled();
      expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
      await old.control.dispose();
      await flush();
      expect(manager.src).toBe(src);
      expectPaused();
      sink.resolve();
      await routing;
      await flush();
      expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
      expect(manager.src).toBe(src);
      expectPaused();
      expect(old.provider.receipt).not.toHaveBeenCalled();
    },
  );

  it.each(["play", "toggle"])(
    "old HTTP %s disposal does not cancel a later ordinary UI play",
    async (action) => {
      const { src, sink, routing } = await pausedOutputSetup();
      const old = await shell(1);
      old.emit(action);
      await flush();
      const explicit = player.play();
      await old.control.dispose();
      sink.resolve();
      await routing;
      await explicit;
      await flush();
      expect(manager.src).toBe(src);
      expect(manager.paused).toBe(false);
      expect(elements.reduce((count, element) => count + element.play.mock.calls.length, 0)).toBe(
        1,
      );
      expect(old.provider.receipt).not.toHaveBeenCalled();
    },
  );

  it.each(["play", "toggle"])(
    "old HTTP %s disposal does not cancel a new owner's pending direct play",
    async (action) => {
      const { src, sink, routing } = await pausedOutputSetup();
      const old = await shell(1);
      old.emit(action);
      await flush();
      const current = await shell(2);
      current.emit("play");
      await flush();
      await old.control.dispose();
      sink.resolve();
      await routing;
      await flush();
      expect(manager.src).toBe(src);
      expect(manager.paused).toBe(false);
      expect(elements.reduce((count, element) => count + element.play.mock.calls.length, 0)).toBe(
        1,
      );
      expect(current.provider.receipt).toHaveBeenCalledWith(2, 1, true);
    },
  );

  it.each(["play", "toggle"])(
    "disposing HTTP %s owner leaves already playing audio untouched",
    async (action) => {
      await player.initPlayer(false);
      const src = manager.src;
      const old = await shell(1);
      old.emit(action);
      await flush();
      expect(manager.paused).toBe(false);
      const pauses = elements.reduce(
        (count, element) => count + element.pause.mock.calls.length,
        0,
      );
      await old.control.dispose();
      await flush();
      expect(manager.src).toBe(src);
      expect(manager.paused).toBe(false);
      expect(elements.reduce((count, element) => count + element.pause.mock.calls.length, 0)).toBe(
        pauses,
      );
    },
  );
  it("keeps the HTTP owner when single-track next resumes through Player.play", async () => {
    mocks.data.playList = [song("A")];
    const { src, sink, routing } = await pausedOutputSetup();
    const old = await shell(1);
    old.emit("next");
    await flush();
    expect(old.provider.receipt).not.toHaveBeenCalled();
    await old.control.dispose();
    sink.resolve();
    await routing;
    await flush();
    expect(manager.src).toBe(src);
    expectPaused();
    expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
    expect(old.provider.receipt).not.toHaveBeenCalled();
  });
});
