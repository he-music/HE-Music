import { describe, expect, it, vi } from "vitest";
import { AudioProcessingDriver } from "@/utils/audioCapability";
import { ControlSession, type ControlCommand, type ControlProvider } from "./controlSession";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  let listener: (command: ControlCommand) => void = () => {};
  let current = Symbol();
  const stop = vi.fn();
  const provider: ControlProvider = {
    start: vi.fn(async () => ({ generation: 2, port: 25666 })),
    receipt: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCommand: (callback) => {
      listener = callback;
      return stop;
    },
  };
  const execute = vi.fn<(action: string) => Promise<void>>(async () => {});
  const failure = vi.fn();
  const session = new ControlSession(provider, { current: () => current, execute }, failure);
  return {
    provider,
    execute,
    failure,
    session,
    stop,
    emit: (action: string, requestId: number, generation = 2) =>
      listener({ action, requestId, generation }),
    change: () => {
      current = Symbol();
    },
  };
}

describe("HTTP control shell session", () => {
  it("executes all legacy actions and acknowledges resolved actions once", async () => {
    const f = fixture();
    await f.session.start();
    const actions = ["play", "pause", "toggle", "next", "prev"];
    actions.forEach((action, index) => f.emit(action, index + 1));
    f.emit("play", 1);
    f.emit("play", 6, 1);
    f.emit("play", Number.NaN);
    await flush();
    expect(f.execute.mock.calls.map(([action]) => action)).toEqual(actions);
    expect(f.provider.receipt).toHaveBeenCalledTimes(5);
    expect(f.provider.receipt).toHaveBeenLastCalledWith(2, 5, true);
  });

  it("rejects changed song identity, unknown action and thrown player actions", async () => {
    const f = fixture();
    await f.session.start();
    f.emit("next", 1);
    f.change();
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 1, false);
    f.emit("open-file", 2);
    await flush();
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 2, false);
    f.execute.mockRejectedValueOnce(new Error("failed"));
    f.emit("play", 3);
    await flush();
    expect(f.failure).toHaveBeenCalledOnce();
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 3, false);
  });

  it("invalidates queued work immediately and suppresses late receipts on disposal", async () => {
    const f = fixture();
    await f.session.start();
    let resolve: () => void = () => {};
    f.execute.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    f.emit("play", 1);
    await flush();
    f.emit("next", 2);
    await f.session.dispose();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(2);
    resolve();
    f.emit("pause", 3);
    await flush();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.provider.receipt).not.toHaveBeenCalled();
  });

  it("subscribes before startup and tears down a late start after disposal", async () => {
    const f = fixture();
    let resolve: (value: { generation: number; port: number }) => void = () => {};
    vi.mocked(f.provider.start).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const starting = f.session.start(25667);
    f.emit("pause", 1);
    const cleanup = f.session.dispose();
    expect(f.session.dispose()).toBe(cleanup);
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });
    await flush();
    expect(cleaned).toBe(false);
    resolve({ generation: 2, port: 25667 });
    await cleanup;
    await starting;
    await flush();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("consumes an event delivered before the binding result resolves", async () => {
    const f = fixture();
    vi.mocked(f.provider.start).mockImplementation(async () => {
      f.emit("pause", 1);
      return { generation: 2, port: 25666 };
    });
    await f.session.start();
    await flush();
    expect(f.execute).toHaveBeenCalledExactlyOnceWith("pause");
  });
});

class ControlAudio extends EventTarget {
  src = "";
  paused = true;
  load() {}
  removeAttribute() {
    this.src = "";
  }
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
}

describe("HTTP control playback cancellation", () => {
  it("runs pause before pending audio play settles and stops a late native success", async () => {
    const audio = new ControlAudio();
    const driver = new AudioProcessingDriver({
      // Minimal inert HTML media stand-in; no browser, network or audio device.
      createElement: () => audio as unknown as HTMLAudioElement,
      frequencies: [],
      probe: async () => false,
    });
    await driver.load("https://audio.example/control");
    let lateSuccess: () => void = () => {};
    audio.play.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        lateSuccess = resolve;
      });
      audio.paused = false;
    });
    const f = fixture();
    let playSettled = false;
    f.execute.mockImplementation(async (action) => {
      if (action === "play") {
        await driver.play();
        playSettled = true;
      } else if (action === "pause") driver.pause();
    });
    await f.session.start();
    f.emit("play", 1);
    await flush();
    expect(playSettled).toBe(false);
    expect(audio.play).toHaveBeenCalledOnce();
    f.emit("pause", 2);
    await flush();
    expect(f.execute.mock.calls.map(([action]) => action)).toEqual(["play", "pause"]);
    expect(playSettled).toBe(true);
    expect(audio.paused).toBe(true);
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 1, false);
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 2, true);
    lateSuccess();
    await flush();
    expect(audio.paused).toBe(true);
    await f.session.dispose();
    driver.dispose();
  });

  it("does not let an unresolved receipt hold later controls", async () => {
    const f = fixture();
    let receiptDone: () => void = () => {};
    vi.mocked(f.provider.receipt).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          receiptDone = resolve;
        }),
    );
    await f.session.start();
    f.emit("play", 1);
    await flush();
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 1, true);
    f.emit("pause", 2);
    f.emit("next", 3);
    await flush();
    expect(f.execute.mock.calls.map(([action]) => action)).toEqual(["play", "pause", "next"]);
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 2, true);
    expect(f.provider.receipt).toHaveBeenCalledWith(2, 3, true);
    receiptDone();
    await f.session.dispose();
  });
});
