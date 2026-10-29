import { describe, expect, it, vi } from "vitest";
import {
  TaskbarSession,
  type TaskbarCommand,
  type TaskbarFailure,
  type TaskbarSnapshot,
  type TaskbarState,
} from "./taskbarSession";

const snapshot = (): TaskbarSnapshot => ({
  enabled: true,
  playing: true,
  positionMs: 1000,
  durationMs: 10000,
  labels: { previous: "Previous", play: "Play", pause: "Pause", next: "Next" },
});
function fixture() {
  let listener: ((command: TaskbarCommand) => void) | undefined;
  let failureListener: ((failure: TaskbarFailure) => void) | undefined;
  const stopFailure = vi.fn();
  const stop = vi.fn();
  const provider = {
    onFailure: vi.fn((listener: (failure: TaskbarFailure) => void) => {
      failureListener = listener;
      return stopFailure;
    }),
    begin: vi.fn(async () => 7),
    sync: vi.fn<(state: TaskbarState) => Promise<void>>(async () => {}),
    teardown: vi.fn<(epoch: number) => Promise<void>>(async () => {}),
    onCommand: vi.fn((cb: (command: TaskbarCommand) => void) => {
      listener = cb;
      return stop;
    }),
  };
  const execute = vi.fn();
  const failure = vi.fn();
  const session = new TaskbarSession(provider, execute, failure);
  return {
    provider,
    session,
    execute,
    failure,
    stop,
    stopFailure,
    emit: (e: TaskbarCommand) => listener?.(e),
    emitFailure: (e: TaskbarFailure) => failureListener?.(e),
  };
}
describe("taskbarSession", () => {
  it("acceptance ACKs retain the command gate until an exact deferred failure retires it once", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.sync(snapshot());
    f.emitFailure({ epoch: 6, seq: 1, code: "native-failed" });
    f.emitFailure({ epoch: 7, seq: 0, code: "native-failed" });
    expect(f.session.executionToken).toBeDefined();
    await f.session.sync(snapshot());
    f.emitFailure({ epoch: 7, seq: 1, code: "native-failed" });
    expect(f.session.executionToken).toBeDefined();
    f.emitFailure({ epoch: 7, seq: 2, code: "native-failed" });
    expect(f.session.executionToken).toBeUndefined();
    f.emit({ epoch: 7, seq: 2, action: "next" });
    f.emitFailure({ epoch: 7, seq: 2, code: "native-failed" });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.failure).toHaveBeenCalledOnce();
    expect(f.stopFailure).toHaveBeenCalledOnce();
    await f.session.dispose();
  });
  it("a deferred failure before the RPC settles cannot reopen its command gate on a late ACK", async () => {
    const f = fixture();
    let acknowledge: () => void = () => {
      throw new Error("missing acknowledgement");
    };
    f.provider.sync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    await f.session.start();
    const pending = f.session.sync(snapshot());
    for (let n = 0; n < 10; n++) await Promise.resolve();
    f.emitFailure({ epoch: 7, seq: 1, code: "native-failed" });
    expect(f.session.executionToken).toBeUndefined();
    acknowledge();
    await pending;
    f.emit({ epoch: 7, seq: 1, action: "toggle" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.failure).toHaveBeenCalledOnce();
  });
  it("releases both subscriptions and ignores an in-flight failure after disposal", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.sync(snapshot());
    await f.session.dispose();
    f.emitFailure({ epoch: 7, seq: 1, code: "native-failed" });
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.stopFailure).toHaveBeenCalledOnce();
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(7);
  });
  it("an obsolete RPC rejection leaves a newer snapshot queued and does not retire its owner", async () => {
    const f = fixture();
    let reject: (error: Error) => void = () => {
      throw new Error("missing pending sync");
    };
    f.provider.sync.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await f.session.start();
    const first = f.session.sync(snapshot());
    for (let n = 0; n < 10; n++) await Promise.resolve();
    const latest = f.session.sync({ ...snapshot(), playing: false });
    reject(new Error("superseded native operation"));
    await Promise.all([first, latest]);
    expect(f.provider.sync).toHaveBeenCalledTimes(2);
    expect(f.provider.teardown).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
    f.emit({ epoch: 7, seq: 2, action: "toggle" });
    expect(f.execute).toHaveBeenCalledExactlyOnceWith("toggle");
    await f.session.dispose();
  });
  it("rejects old epoch, sequence, disabled and retired events", async () => {
    const f = fixture();
    await f.session.start();
    await f.session.sync(snapshot());
    const emit = (epoch: number, seq: number) => f.emit({ epoch, seq, action: "toggle" });
    emit(6, 1);
    emit(7, 0);
    expect(f.execute).not.toHaveBeenCalled();
    emit(7, 1);
    expect(f.execute).toHaveBeenCalledWith("toggle");
    const token = f.session.executionToken;
    const pending = f.session.sync({ ...snapshot(), playing: false });
    emit(7, 1);
    expect(f.session.executionToken).not.toBe(token);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await pending;
    emit(7, 2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.session.sync({ ...snapshot(), enabled: false });
    emit(7, 3);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.session.dispose();
    await f.session.dispose();
    emit(7, 3);
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(7);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  it.each([-1, 0.5, NaN, Infinity, 10001, Number.MAX_SAFE_INTEGER + 1])(
    "invalid position %s retires native owner",
    async (positionMs) => {
      const f = fixture();
      await f.session.start();
      await f.session.sync({ ...snapshot(), positionMs });
      expect(f.provider.sync).not.toHaveBeenCalled();
      expect(f.failure).toHaveBeenCalledTimes(1);
      expect(f.provider.teardown).toHaveBeenCalledWith(7);
    },
  );
  it("accepts zero duration and paused state, copies labels and coalesces pending snapshots", async () => {
    const f = fixture();
    await f.session.start();
    const state = { ...snapshot(), playing: false, positionMs: 0, durationMs: 0 };
    const first = f.session.sync(state);
    state.labels.play = "Changed";
    const second = f.session.sync({ ...state, labels: { ...state.labels, play: "Play" } });
    await Promise.all([first, second]);
    expect(f.provider.sync).toHaveBeenCalledTimes(1);
    expect(f.provider.sync).toHaveBeenCalledWith({
      ...state,
      epoch: 7,
      seq: 2,
      labels: { ...state.labels, play: "Play" },
    });
  });
  it("retires a begin that completes after disposal", async () => {
    const f = fixture();
    let resolve: ((epoch: number) => void) | undefined;
    f.provider.begin.mockImplementation(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    const start = f.session.start();
    const end = f.session.dispose();
    resolve?.(8);
    await Promise.all([start, end]);
    expect(f.provider.teardown).toHaveBeenCalledExactlyOnceWith(8);
    expect(f.session.executionToken).toBeUndefined();
  });
  it("native failure closes command gate and tears down without another mutation", async () => {
    const f = fixture();
    f.provider.sync.mockRejectedValueOnce(new Error("COM failed"));
    await f.session.start();
    await f.session.sync(snapshot());
    f.emit({ epoch: 7, seq: 1, action: "next" });
    await f.session.dispose();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledTimes(1);
    expect(f.provider.teardown).toHaveBeenCalledTimes(1);
  });
});
