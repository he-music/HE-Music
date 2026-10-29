import { afterEach, describe, expect, it, vi } from "vitest";
import { createMygoPlatform } from "./mygo";
import type { LyricsClock, LyricsSnapshot, LyricsWindowState } from "./desktopLyrics";
import type { TrayPlaybackState, TrayRequest } from "./mygo.bindings";
import { DesktopLyricsSession } from "./desktopLyricsSession";
const bridge = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), os: "darwin" }));
vi.mock("mygo-runtime", () => ({
  runtime: () => ({ platform: bridge.os }),
  currentWindow: {},
  call: (...args: unknown[]) => bridge.call(...args),
  event: (name: string) => ({ on: (listener: unknown) => bridge.on(name, listener) }),
}));
afterEach(() => {
  vi.clearAllMocks();
  bridge.os = "darwin";
});
describe("mygo lifecycle capability", () => {
  it("only exposes Windows taskbar providers and forwards exact deferred native failure events", async () => {
    expect(createMygoPlatform().taskbar).toBeUndefined();
    bridge.os = "win32";
    const adapter = createMygoPlatform();
    const taskbar = adapter.taskbar;
    if (!taskbar?.onFailure) throw new Error("Missing deferred taskbar failure subscription");
    const off = vi.fn();
    bridge.on.mockReturnValueOnce(off);
    const listener = vi.fn();
    const stop = taskbar.onFailure(listener);
    expect(bridge.on).toHaveBeenLastCalledWith("desktop:taskbar-failure", listener);
    stop();
    expect(off).toHaveBeenCalledOnce();
    bridge.call.mockResolvedValueOnce(undefined);
    await adapter.files?.forgetDownload?.(4, "operation");
    expect(bridge.call).toHaveBeenLastCalledWith("NativeFiles.ForgetDownload", 4, "operation");
  });
  it("forwards the full tray snapshot and typed favorite=false event and releases the exact subscription", async () => {
    const adapter = createMygoPlatform();
    const lifecycle = adapter.lifecycle;
    if (!lifecycle) throw new Error("No lifecycle");
    const snapshot: TrayPlaybackState = {
      epoch: 9,
      revision: 3,
      trackKey: "track",
      playing: true,
      hasSong: true,
      liked: true,
      canFavorite: true,
      canSetMode: true,
      playMode: "shuffle",
    };
    bridge.call.mockResolvedValueOnce(undefined);
    await lifecycle.syncPlayback(snapshot);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLifecycle.SyncPlayback", snapshot);
    const off = vi.fn();
    bridge.on.mockReturnValueOnce(off);
    const listener = vi.fn<(request: TrayRequest) => void>();
    const stop = lifecycle.onTrayAction(listener);
    expect(bridge.on).toHaveBeenLastCalledWith("desktop:tray-action", listener);
    const emit = bridge.on.mock.calls.at(-1)?.[1];
    if (typeof emit !== "function") throw new Error("No listener");
    const request: TrayRequest = {
      epoch: 9,
      revision: 3,
      trackKey: "track",
      action: "set-favorite",
      favorite: false,
    };
    emit(request);
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
  it("仅成功ready且tray可用才启用隐藏，teardown立即撤销能力", async () => {
    const adapter = createMygoPlatform();
    expect(adapter.capabilities.tray).toBe(false);
    bridge.call.mockResolvedValueOnce({ trayAvailable: true, epoch: 1 });
    const nativeStatus = await adapter.lifecycle?.ready({
      showCloseAppTip: true,
      closeAppMethod: "exit",
      labels: {
        show: "show",
        play: "play",
        pause: "pause",
        previous: "prev",
        next: "next",
        quit: "quit",
      },
    });
    expect(nativeStatus?.epoch).toBe(1);
    expect(adapter.capabilities.tray).toBe(true);
    bridge.call.mockResolvedValueOnce(undefined);
    const teardown = adapter.lifecycle?.teardown();
    expect(adapter.capabilities.tray).toBe(false);
    await teardown;
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLifecycle.Teardown");
  });
  it.each([false, "failure"])("不可用或ready失败不暴露隐藏能力：%s", async (available) => {
    const adapter = createMygoPlatform();
    if (available === "failure") bridge.call.mockRejectedValueOnce(new Error("synthetic"));
    else bridge.call.mockResolvedValueOnce({ trayAvailable: false, epoch: 1 });
    const operation = adapter.lifecycle?.ready({
      showCloseAppTip: true,
      closeAppMethod: "hide",
      labels: {
        show: "show",
        play: "play",
        pause: "pause",
        previous: "prev",
        next: "next",
        quit: "quit",
      },
    });
    if (available === "failure") await expect(operation).rejects.toThrow("synthetic");
    else await operation;
    expect(adapter.capabilities.tray).toBe(false);
  });
  it("歌词provider映射官方方法与四个事件，未提前开放功能开关", async () => {
    const adapter = createMygoPlatform();
    const lyrics = adapter.desktopLyrics;
    if (!lyrics) throw new Error("Expected native lyrics provider");
    const state: LyricsWindowState = {
      epoch: 4,
      revision: 1,
      visible: false,
      pending: false,
      locked: false,
      hoverUnlock: false,
      bounds: { x: 0, y: 0, width: 800, height: 180 },
      failure: "",
    };
    const snapshot: LyricsSnapshot = {
      epoch: 4,
      seq: 1,
      trackKey: "synthetic",
      playName: "Song",
      artistName: "Artist",
      playing: true,
      positionMs: 1200,
      offsetMs: -175,
      rate: 1,
      loading: false,
      lrcData: [],
      yrcData: [],
    };
    const clock: LyricsClock = {
      epoch: 4,
      seq: 2,
      trackKey: "synthetic",
      playing: false,
      positionMs: 1500,
      offsetMs: -175,
      rate: 1.5,
    };
    bridge.call.mockImplementation(async (method: string) => {
      if (method === "DesktopLyrics.Begin") return { epoch: 4 };
      if (method === "DesktopLyrics.Attach") return { window: state, snapshot };
      if (
        [
          "DesktopLyrics.SetVisible",
          "DesktopLyrics.Close",
          "DesktopLyrics.SetBounds",
          "DesktopLyrics.GetState",
        ].includes(method)
      )
        return state;
      return undefined;
    });
    await expect(lyrics.begin()).resolves.toEqual({ epoch: 4 });
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.Begin");
    await lyrics.publishSnapshot(snapshot);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.PublishSnapshot", snapshot);
    await lyrics.publishClock(clock);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.PublishClock", clock);
    await expect(lyrics.attach()).resolves.toEqual({ window: state, snapshot });
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.Attach");
    await lyrics.setVisible(4, true);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.SetVisible", 4, true);
    await lyrics.close(4);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.Close", 4);
    await lyrics.setBounds(4, state.bounds);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.SetBounds", 4, state.bounds);
    await lyrics.getState(4);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.GetState", 4);
    const command = { epoch: 4, trackKey: "synthetic", action: "toggle" as const };
    await lyrics.command(command);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.Command", command);
    await lyrics.teardown(4);
    expect(bridge.call).toHaveBeenLastCalledWith("DesktopLyrics.Teardown", 4);

    const listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const off = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    for (const unsubscribe of off) bridge.on.mockReturnValueOnce(unsubscribe);
    const stops = [
      lyrics.onWindow(listeners[0]),
      lyrics.onSnapshot(listeners[1]),
      lyrics.onClock(listeners[2]),
      lyrics.onCommand(listeners[3]),
    ];
    expect(bridge.on.mock.calls).toEqual([
      ["desktop:lyrics-window", listeners[0]],
      ["desktop:lyrics-snapshot", listeners[1]],
      ["desktop:lyrics-clock", listeners[2]],
      ["desktop:lyrics-command", listeners[3]],
    ]);
    stops.forEach((stop, index) => {
      expect(stop).toBe(off[index]);
      stop();
      expect(off[index]).toHaveBeenCalledOnce();
    });
    expect(adapter.capabilities.desktopLyrics).toBe(false);
  });
  it("歌词能力仅随主会话Ready启用，处置同步撤销", async () => {
    const adapter = createMygoPlatform();
    const provider = adapter.desktopLyrics;
    if (!provider) throw new Error("Expected native lyrics provider");
    const state: LyricsWindowState = {
      epoch: 9,
      revision: 1,
      visible: false,
      pending: false,
      locked: false,
      hoverUnlock: false,
      bounds: { x: 0, y: 0, width: 800, height: 180 },
      failure: "",
    };
    bridge.on.mockReturnValue(() => {});
    bridge.call.mockImplementation(async (method: string) => {
      if (method === "DesktopLyrics.Begin") return { epoch: 9 };
      if (method === "DesktopLyrics.GetState") return state;
      return undefined;
    });
    const session = new DesktopLyricsSession(provider, {
      trackKey: () => "synthetic",
      snapshotDependencies: () => [],
      clockDependencies: () => [],
      snapshot: () => ({
        trackKey: "synthetic",
        playName: "Song",
        artistName: "Artist",
        playing: false,
        positionMs: 0,
        offsetMs: 0,
        rate: 1,
        loading: false,
        lrcData: [],
        yrcData: [],
      }),
      clock: () => ({
        trackKey: "synthetic",
        playing: false,
        positionMs: 0,
        offsetMs: 0,
        rate: 1,
      }),
      onSeek: () => () => {},
      execute: () => {},
    });
    try {
      expect(adapter.capabilities.desktopLyrics).toBe(false);
      const starting = session.start();
      expect(adapter.capabilities.desktopLyrics).toBe(false);
      await starting;
      expect(adapter.capabilities.desktopLyrics).toBe(true);
      const cleanup = session.dispose();
      expect(adapter.capabilities.desktopLyrics).toBe(false);
      await cleanup;
    } finally {
      await session.dispose();
    }
  });
});
