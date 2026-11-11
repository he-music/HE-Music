import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackRecovery, type PlaybackRecoveryDependencies } from "./playbackRecovery";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

interface DialogCallbacks {
  onPositiveClick(): unknown;
  onNegativeClick(): unknown;
  onClose(): unknown;
  onEsc(): unknown;
}

function setup() {
  const context = {
    requestId: 1,
    radio: false,
    autoPlay: true,
    owner: undefined as (() => boolean) | undefined,
    song: { id: "a", platform: "test" },
  };
  const status = { playStatus: true, playLoading: true, playQuality: "flac" };
  const audio = {
    engineId: "web-audio" as "web-audio" | "mpv",
    error: undefined as PlaybackRecoveryDependencies["audio"]["error"],
    getErrorCode: vi.fn(() => 4),
    pause: vi.fn(async () => {}),
  };
  const deps = {
    audio,
    isMygo: () => true,
    getRequestId: () => context.requestId,
    hasRadioOperation: () => context.radio,
    clearRadioOperation: vi.fn(() => {
      context.radio = false;
    }),
    getAutoPlayIntent: () => context.autoPlay,
    getAutoPlayOwner: () => context.owner,
    revokeAutoPlay: vi.fn(() => {
      context.autoPlay = false;
    }),
    getStatus: () => status,
    getSong: () => context.song,
    getPlaylistLength: () => 2,
    getSeek: () => 12000,
    getSongLogInfo: () => "test song",
    logError: vi.fn(),
    selectMpv: vi.fn(),
    initPlayer: vi.fn<PlaybackRecoveryDependencies["initPlayer"]>(async () => {}),
    createPlayer: vi.fn<PlaybackRecoveryDependencies["createPlayer"]>(async () => {}),
    next: vi.fn<PlaybackRecoveryDependencies["next"]>(async () => {}),
  } satisfies PlaybackRecoveryDependencies;
  const destroy = vi.fn();
  const warning = vi.fn<(options: DialogCallbacks) => unknown>(() => ({ destroy }));
  const error = vi.fn();
  const open = vi.fn();
  vi.stubGlobal("window", {
    location: { protocol: "https:" },
    $dialog: { warning },
    $message: { error },
    open,
  });
  const recovery = new PlaybackRecovery(deps);
  const record = (src = "http://audio.example/a.mp3", requestId = context.requestId) =>
    recovery.recordAttempt({ src, requestId, autoPlay: true, seek: 1000 });
  const dialog = () => warning.mock.calls.at(-1)![0];
  return { recovery, context, status, deps, audio, warning, destroy, error, open, record, dialog };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fail(recovery: PlaybackRecovery, code = 3) {
  await recovery.handlePlaybackError(code);
  vi.advanceTimersByTime(200);
}

describe("PlaybackRecovery retry budget", () => {
  it("deduplicates errors before 200ms and admits the exact boundary", async () => {
    const { recovery, deps } = setup();
    await recovery.handlePlaybackError(2);
    vi.advanceTimersByTime(199);
    await recovery.handlePlaybackError(2);
    expect(deps.initPlayer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await recovery.handlePlaybackError(2);
    expect(deps.initPlayer).toHaveBeenCalledTimes(2);
    expect(deps.next).not.toHaveBeenCalled();
  });

  it("refreshes only the first two network errors and stops the fourth song failure", async () => {
    const { recovery, deps, error } = setup();
    for (let i = 0; i < 4; i++) await fail(recovery, 2);
    expect(deps.initPlayer).toHaveBeenCalledTimes(2);
    expect(deps.next).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenLastCalledWith("播放错误次数过多，已停止播放");
  });

  it("preserves the existing equality check for the per-song limit", async () => {
    const { recovery, deps } = setup();
    for (let i = 0; i < 5; i++) await fail(recovery);
    expect(deps.next).toHaveBeenCalledTimes(4);
  });

  it("resets the song budget by both id and platform but stops at total 15", async () => {
    const { recovery, context, deps, error } = setup();
    for (let i = 0; i < 15; i++) {
      context.song = { id: "same-id", platform: `platform-${i}` };
      await fail(recovery);
    }
    expect(deps.next).toHaveBeenCalledTimes(14);
    expect(error).toHaveBeenLastCalledWith("播放错误次数过多，已停止播放");
    context.song.id = "sixteenth";
    await fail(recovery);
    expect(deps.next).toHaveBeenCalledTimes(14);
  });

  it("canplay resets both budgets while closing dialogs and clearing attempts does not", async () => {
    const { recovery, deps, error } = setup();
    for (let i = 0; i < 3; i++) await fail(recovery);
    recovery.closeHttpDialog();
    recovery.closeMpvDialog();
    recovery.clearAttempt();
    await fail(recovery);
    expect(deps.next).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenLastCalledWith("播放错误次数过多，已停止播放");
    recovery.onCanPlay("a-test");
    await fail(recovery, 2);
    expect(deps.initPlayer).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 14; i++) {
      const song = deps.getSong();
      song.id = `song-${i}`;
      await fail(recovery);
    }
    expect(deps.next).toHaveBeenCalledTimes(16);
    expect(error).toHaveBeenLastCalledWith("播放错误次数过多，已停止播放");
  });

  it("reads the latest pause and owner intent when refreshing or skipping", async () => {
    const { recovery, context, deps } = setup();
    context.autoPlay = false;
    context.owner = () => true;
    await fail(recovery, 2);
    expect(deps.initPlayer).toHaveBeenLastCalledWith(false, 12000, "", context.owner);
    await fail(recovery, 3);
    expect(deps.next).toHaveBeenLastCalledWith(false, false, context.owner);
  });
});

describe("PlaybackRecovery dialog contracts", () => {
  it("prioritizes HTTPS, deduplicates it, and settles dismissal only once", () => {
    const { recovery, record, warning, dialog, deps } = setup();
    record();
    recovery.handleMediaError(4);
    recovery.handleMediaError(4);
    expect(warning).toHaveBeenCalledTimes(1);
    dialog().onClose();
    dialog().onEsc();
    expect(deps.next).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    recovery.closeHttpDialog();
    recovery.clearAttempt();
    record();
    recovery.handleMediaError(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(deps.initPlayer).toHaveBeenCalledTimes(1);
  });

  it("rejects destroyed HTTPS callbacks after a newer request", () => {
    const { recovery, context, record, dialog, deps, open, destroy } = setup();
    record();
    recovery.handleMediaError(4);
    const old = dialog();
    context.requestId++;
    recovery.closeHttpDialog();
    recovery.clearAttempt();
    old.onPositiveClick();
    old.onNegativeClick();
    old.onClose();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(deps.createPlayer).not.toHaveBeenCalled();
    expect(deps.next).not.toHaveBeenCalled();
  });

  it("keeps HTTPS validity based on request alone and retries using the latest attempt intent", () => {
    const { recovery, context, record, dialog, deps } = setup();
    record();
    recovery.handleMediaError(4);
    recovery.cancelAttemptAutoplay(0);
    recovery.updateAttemptIntent(true, () => context.autoPlay);
    recovery.cancelAttemptAutoplay(1);
    context.radio = true;
    deps.audio.engineId = "mpv";
    dialog().onNegativeClick();
    expect(deps.clearRadioOperation).toHaveBeenCalledTimes(1);
    expect(deps.createPlayer).toHaveBeenCalledWith(
      "https://audio.example/a.mp3",
      false,
      12000,
      expect.any(Function),
      undefined,
    );
  });

  it.each(["request", "radio", "engine"])(
    "ignores late mpv callbacks after %s changes",
    async (change) => {
      const { recovery, context, record, dialog, deps } = setup();
      record("https://audio.example/a.mp3");
      recovery.handleMediaError(3);
      const old = dialog();
      if (change === "request") context.requestId++;
      if (change === "radio") context.radio = true;
      if (change === "engine") deps.audio.engineId = "mpv";
      recovery.closeMpvDialog();
      await old.onPositiveClick();
      old.onNegativeClick();
      expect(deps.selectMpv).not.toHaveBeenCalled();
      expect(deps.initPlayer).not.toHaveBeenCalled();
      expect(deps.revokeAutoPlay).not.toHaveBeenCalled();
    },
  );

  it("deduplicates mpv by request even after dismissal and permits a new request", () => {
    const { recovery, context, record, dialog, warning, deps } = setup();
    record("https://audio.example/a.mp3");
    recovery.handleMediaError(3);
    dialog().onNegativeClick();
    recovery.closeMpvDialog();
    recovery.handleMediaError(3);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(deps.next).not.toHaveBeenCalled();
    context.requestId++;
    record("https://audio.example/a.mp3");
    recovery.handleMediaError(3);
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("ignores a late HTTPS retry rejection after its request was replaced", async () => {
    const { recovery, context, record, dialog, deps } = setup();
    let reject!: (error: Error) => void;
    deps.createPlayer.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    deps.audio.getErrorCode.mockReturnValue(0);
    record();
    recovery.handleMediaError(4);
    dialog().onNegativeClick();
    context.requestId++;
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(deps.logError).not.toHaveBeenCalled();
    expect(deps.next).not.toHaveBeenCalled();
  });
});
