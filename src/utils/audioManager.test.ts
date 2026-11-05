import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ isElectron: false, isMygo: false }));
vi.mock("./env", () => host);

class FakeAudio extends EventTarget {
  src = "";
  crossOrigin: string | null = null;
  currentTime = 0;
  duration = 180;
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  paused = true;
  error: { code: number; message?: string } | null = null;
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
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

let audio: FakeAudio;
let manager: typeof import("./audioManager").default;
let audioContext: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("synthetic source has no CORS access")),
  );
  vi.stubGlobal("Audio", function () {
    audio = new FakeAudio();
    return audio;
  });
  audioContext = vi.fn(() => {
    throw new Error("Web/mygo must not create an audio graph");
  });
  vi.stubGlobal("AudioContext", audioContext);
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_ABORTED: 1,
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["web", "mygo"])("AudioManager %s HTMLAudio path", (kind) => {
  beforeEach(async () => {
    host.isMygo = kind === "mygo";
    manager = (await import("./audioManager")).default;
  });

  it("clears buffered source when its local authorization is revoked", async () => {
    await manager.play("http://127.0.0.1:12345/ticket", { autoPlay: false });
    const revoked = audio;
    revoked.load.mockClear();
    revoked.removeAttribute.mockClear();
    manager.clearSource();
    expect(revoked.removeAttribute).toHaveBeenCalledExactlyOnceWith("src");
    expect(revoked.src).toBe("");
    expect(revoked.load).toHaveBeenCalledOnce();
    expect(audio.paused).toBe(true);
  });
  it("preloads without play, then resumes and pauses without a WebAudio graph", async () => {
    await manager.play("https://audio.example/first.mp3", { autoPlay: false });
    expect(audio.load).toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.crossOrigin).toBeNull();
    audio.pause.mockClear();
    await manager.play(undefined, { fadeIn: true, fadeDuration: 0.3 });
    expect(manager.paused).toBe(false);
    manager.pause({ fadeOut: true, fadeDuration: 0.3 });
    expect(manager.paused).toBe(true);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audioContext).not.toHaveBeenCalled();
    expect(manager.getFrequencyData()).toHaveLength(0);
  });

  it("switches sources, seeks and forwards the media clock without extra timers", async () => {
    const tick = vi.fn();
    manager.on("timeupdate", tick);
    manager.setVolume(0.7);
    manager.setRate(1.25);
    await manager.play("https://audio.example/first.mp3");
    manager.seek(12.5);
    audio.dispatchEvent(new Event("timeupdate"));
    expect(manager.currentTime).toBe(12.5);
    expect(manager.duration).toBe(180);
    expect(tick).toHaveBeenCalledOnce();
    await manager.play("https://audio.example/second.mp3");
    expect(manager.src).toBe("https://audio.example/second.mp3");
    expect(manager.currentTime).toBe(0);
    expect(audio.volume).toBe(0.7);
    expect(audio.playbackRate).toBe(1.25);
    manager.off("timeupdate", tick);
    audio.dispatchEvent(new Event("timeupdate"));
    expect(tick).toHaveBeenCalledOnce();
  });

  it("propagates a policy rejection without a media error and allows a later gesture", async () => {
    const mediaError = vi.fn();
    manager.on("error", mediaError);
    const rejection = new DOMException("blocked", "NotAllowedError");
    audio.play.mockRejectedValueOnce(rejection);
    await expect(manager.play("https://audio.example/first.mp3")).rejects.toBe(rejection);
    expect(mediaError).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("AudioManager: 播放失败", rejection);
    await manager.play();
    expect(manager.paused).toBe(false);
    expect(audio.load).toHaveBeenCalled();
  });

  it.each([2, 3, 4])("preserves media error code %s for existing recovery", async (code) => {
    const listener = vi.fn<(event: Event) => void>();
    manager.on("error", listener);
    audio.error = { code, message: "Media load failed" };
    audio.dispatchEvent(new Event("error"));
    expect(manager.getErrorCode()).toBe(code);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ errorCode: code, errorMessage: "Media load failed" }),
      }),
    );
  });

  it("does not require setSinkId support or create an audio context", async () => {
    await manager.play("https://audio.example/first.mp3", { autoPlay: false });
    await expect(manager.setSinkId("default")).resolves.toBeUndefined();
    await expect(manager.setSinkId("persisted-device")).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    expect(audioContext).not.toHaveBeenCalled();
  });
});
