import { describe, expect, it, vi } from "vitest";
import {
  createMpvPlaybackProvider,
  type MpvEvent,
  type MpvPlaybackCommands,
  type MpvSnapshot,
} from "./mpvPlayback";

const snapshot = (lifecycle = 1, session = 1, sequence = 1): MpvSnapshot => ({
  lifecycle,
  session,
  sequence,
  state: "paused",
  position: 0,
  duration: 10,
  rate: 1,
  volume: 1,
  source: "synthetic",
  device: "auto",
  error: null,
});

function fixture() {
  const commands: MpvPlaybackCommands = {
    initialize: vi.fn(async () => snapshot()),
    load: vi.fn(async () => snapshot()),
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => snapshot()),
    clearSource: vi.fn(async () => snapshot()),
    seek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    setRate: vi.fn(async () => {}),
    getOutputDevices: vi.fn(async () => []),
    setOutputDevice: vi.fn(async () => {}),
    snapshot: vi.fn(async () => snapshot()),
    destroy: vi.fn(async () => {}),
  };
  const listeners = new Set<(event: MpvEvent) => void>();
  const released = vi.fn();
  const provider = createMpvPlaybackProvider(commands, (listener) => {
    listeners.add(listener);
    return () => {
      released();
      listeners.delete(listener);
    };
  });
  return { commands, listeners, released, provider };
}

describe("mpvPlayback 平台 provider", () => {
  it("保持延迟初始化并丢弃旧生命周期、会话和重复快照", () => {
    const { provider, commands, listeners } = fixture();
    const received = vi.fn();
    provider.onEvent(received);
    const emit = (value: MpvSnapshot) => {
      for (const listener of listeners) listener({ type: "timeupdate", snapshot: value });
    };
    emit(snapshot(1, 2, 3));
    emit(snapshot(1, 1, 100));
    emit(snapshot(1, 2, 3));
    emit(snapshot(1, 2, 2));
    emit(snapshot(1, 2, 4));
    emit(snapshot(2, 0, 1));
    emit(snapshot(1, 100, 1000));
    expect(received).toHaveBeenCalledTimes(3);
    expect(commands.initialize).not.toHaveBeenCalled();
    expect(provider.capabilities).toEqual({
      supportsRate: true,
      supportsSinkId: true,
      supportsEqualizer: false,
      supportsSpectrum: false,
      supportsFade: false,
    });
  });

  it("取消订阅只释放自己，teardown 阻止已排队回调进入旧 owner", () => {
    const { provider, listeners, released } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const off = provider.onEvent(first);
    provider.onEvent(second);
    const queued = [...listeners];
    off();
    off();
    for (const listener of queued) listener({ type: "ended", snapshot: snapshot() });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledTimes(1);
    provider.teardown();
    provider.teardown();
    for (const listener of queued) listener({ type: "ended", snapshot: snapshot(1, 1, 2) });
    expect(second).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });
});
