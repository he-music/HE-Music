import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdatesSession, updatesSession } from "./updatesSession";
import type { PlatformUpdates, UpdatesEvent, UpdatesState } from "./updates";

function snapshot(overrides: Partial<UpdatesState> = {}): UpdatesState {
  return {
    epoch: 7,
    operationRevision: 0,
    stateRevision: 1,
    phase: "idle",
    code: "",
    version: "",
    notes: "",
    date: "",
    downloaded: 0,
    total: 0,
    installBusy: false,
    ...overrides,
  };
}
class FakeUpdates implements PlatformUpdates {
  readonly listeners = new Set<(event: UpdatesEvent) => void>();
  begin = vi.fn<PlatformUpdates["begin"]>(async () => {});
  check = vi.fn<PlatformUpdates["check"]>(async () => {});
  install = vi.fn<PlatformUpdates["install"]>(async () => {});
  getState = vi.fn<PlatformUpdates["getState"]>(async () => {});
  download = vi.fn<PlatformUpdates["download"]>(async () => {});
  cancel = vi.fn<NonNullable<PlatformUpdates["cancel"]>>(async () => {});
  restart = vi.fn<PlatformUpdates["restart"]>(async () => {});
  teardown = vi.fn<PlatformUpdates["teardown"]>(async () => {});
  onChange = vi.fn<PlatformUpdates["onChange"]>((listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });
  emit(id: number, state = snapshot(), code = "") {
    this.listeners.forEach((listener) => listener({ requestId: id, state, code }));
  }
}
const cleanups: UpdatesSession[] = [];
function fixture(provider = new FakeUpdates()) {
  const session = new UpdatesSession(provider, {
    acknowledgementTimeoutMs: 20,
    operationTimeoutMs: 30,
    cleanupTimeoutMs: 20,
  });
  cleanups.push(session);
  return { provider, session };
}
function onlyID(calls: readonly (readonly number[])[]): number {
  const id = calls.at(-1)?.[0];
  if (id === undefined) throw new Error("Missing command");
  return id;
}
async function start(f: ReturnType<typeof fixture>, state = snapshot()) {
  const starting = f.session.start();
  f.provider.emit(onlyID(f.provider.begin.mock.calls), state);
  await starting;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(cleanups.splice(0).map((session) => session.dispose()));
  await vi.runAllTimersAsync();
  await cleanup;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
it.each(["cancelled", "installed"])(
  "keeps the install fence until the actual %s result after cancellation",
  async (phase) => {
    const f = fixture();
    await start(f, snapshot({ phase: "available", operationRevision: 1, version: "2.0.0" }));
    const installing = f.session.install();
    const installID = onlyID(f.provider.install.mock.calls);
    const native = {
      operationRevision: 2,
      phase: "installing",
      installBusy: true,
      total: 100,
      downloaded: 20,
    };
    f.provider.emit(installID, snapshot({ ...native, stateRevision: 2 }));
    expect(f.session.canCancel.value).toBe(true);
    const cancelling = f.session.cancel();
    const cancelID = onlyID(f.provider.cancel.mock.calls);
    await Promise.resolve();
    expect(f.session.cancelling.value).toBe(true);
    expect(f.session.busy.value).toBe(true);
    f.provider.emit(cancelID, snapshot({ ...native, stateRevision: 3, code: "cancel-requested" }));
    await cancelling;
    expect(f.session.busy.value).toBe(true);
    expect(f.session.canCancel.value).toBe(false);
    f.provider.emit(installID, snapshot({ operationRevision: 2, stateRevision: 4, phase }));
    await expect(installing).resolves.toMatchObject({ phase });
    expect(f.session.busy.value).toBe(false);
  },
);

it("does not offer cancellation after the download completes", async () => {
  const f = fixture();
  await start(f, snapshot({ phase: "available" }));
  const installing = f.session.install();
  const id = onlyID(f.provider.install.mock.calls);
  f.provider.emit(
    id,
    snapshot({
      operationRevision: 1,
      stateRevision: 2,
      phase: "installing",
      installBusy: true,
      total: 100,
      downloaded: 100,
    }),
  );
  expect(f.session.canCancel.value).toBe(false);
  await expect(f.session.cancel()).rejects.toThrow("unavailable");
  expect(f.provider.cancel).not.toHaveBeenCalled();
  f.provider.emit(id, snapshot({ operationRevision: 1, stateRevision: 3, phase: "installed" }));
  await installing;
});

it("subscribes before Begin and an early event still waits for RPC queue acknowledgement", async () => {
  const f = fixture();
  let resolve!: () => void;
  f.provider.begin.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  const starting = f.session.start();
  expect(f.provider.onChange).toHaveBeenCalledBefore(f.provider.begin);
  expect(f.session.start()).toBe(starting);
  f.provider.emit(onlyID(f.provider.begin.mock.calls));
  expect(f.session.ready.value).toBe(false);
  resolve();
  await starting;
  expect(f.session.ready.value).toBe(true);
});

it("RPC resolution alone does not authorize the update session", async () => {
  const f = fixture();
  const starting = f.session.start();
  await Promise.resolve();
  expect(f.session.ready.value).toBe(false);
  f.provider.emit(onlyID(f.provider.begin.mock.calls));
  await starting;
  expect(updatesSession.value).toBe(f.session);
});

it("bounds a Begin whose RPC never resolves and releases the late-listener deadline", async () => {
  const f = fixture();
  f.provider.begin.mockImplementationOnce(() => new Promise<void>(() => {}));
  const starting = f.session.start();
  const failure = expect(starting).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  await failure;
  f.provider.emit(onlyID(f.provider.begin.mock.calls), snapshot({ epoch: 9 }));
  await Promise.resolve();
  expect(f.provider.teardown).toHaveBeenCalledWith(expect.any(Number), 9);
  expect(f.session.ready.value).toBe(false);
});

it("disposes a pending Begin, releases its exact late epoch and keeps a newer session", async () => {
  const provider = new FakeUpdates();
  const old = fixture(provider);
  const starting = old.session.start();
  const oldID = onlyID(provider.begin.mock.calls);
  const failure = expect(starting).rejects.toThrow("ended");
  const cleanup = old.session.dispose();
  const next = fixture(provider);
  await start(next, snapshot({ epoch: 8 }));
  provider.emit(oldID, snapshot({ epoch: 7 }));
  await failure;
  await cleanup;
  expect(provider.teardown).toHaveBeenCalledWith(expect.any(Number), 7);
  expect(updatesSession.value).toBe(next.session);
  expect(next.session.ready.value).toBe(true);
});

it("resolves a check only at its matching native terminal state", async () => {
  const f = fixture();
  await start(f);
  const checking = f.session.check();
  const id = onlyID(f.provider.check.mock.calls);
  const revision = f.provider.check.mock.calls.at(-1)?.[2];
  f.provider.emit(
    id,
    snapshot({ operationRevision: revision, stateRevision: 2, phase: "checking" }),
  );
  expect(f.session.busy.value).toBe(true);
  f.provider.emit(
    0,
    snapshot({ operationRevision: revision, stateRevision: 3, phase: "available" }),
  );
  expect(f.session.busy.value).toBe(true);
  f.provider.emit(
    id,
    snapshot({ operationRevision: revision, stateRevision: 3, phase: "available" }),
  );
  await expect(checking).resolves.toMatchObject({ phase: "available" });
  expect(f.session.busy.value).toBe(false);
});

it("handles a rejected operation with the unchanged native revision immediately", async () => {
  const f = fixture();
  await start(f);
  const checking = f.session.check();
  f.provider.emit(onlyID(f.provider.check.mock.calls), snapshot(), "install-busy");
  await expect(checking).rejects.toThrow("install-busy");
  expect(f.session.busy.value).toBe(false);
});

it("ignores foreign, stale and wrong-operation events without corrupting current state", async () => {
  const f = fixture();
  await start(f);
  const checking = f.session.check();
  const id = onlyID(f.provider.check.mock.calls);
  f.provider.emit(
    id,
    snapshot({ epoch: 8, stateRevision: 9, operationRevision: 1, phase: "available" }),
  );
  f.provider.emit(id, snapshot({ stateRevision: 9, operationRevision: 2, phase: "available" }));
  expect(f.session.state.value?.phase).toBe("idle");
  f.provider.emit(id, snapshot({ stateRevision: 2, operationRevision: 1, phase: "available" }));
  await checking;
  f.provider.emit(0, snapshot({ stateRevision: 3, operationRevision: 0 }));
  expect(f.session.state.value?.phase).toBe("available");
});

it("keeps unavailable distinct from no-update and installs only an available candidate", async () => {
  const f = fixture();
  await start(f);
  await expect(f.session.install()).rejects.toThrow("unavailable");
  const checking = f.session.check();
  f.provider.emit(
    onlyID(f.provider.check.mock.calls),
    snapshot({ operationRevision: 1, stateRevision: 2, phase: "unavailable", code: "unavailable" }),
  );
  await expect(checking).resolves.toMatchObject({ phase: "unavailable" });
  expect(f.provider.install).not.toHaveBeenCalled();
});

it("holds an uncertain installation fence after transport failure until explicit native resync", async () => {
  const f = fixture();
  await start(f, snapshot({ phase: "available" }));
  f.provider.install.mockRejectedValueOnce(new Error("transport lost"));
  await expect(f.session.install()).rejects.toThrow("delivered");
  expect(f.session.busy.value).toBe(true);
  await expect(f.session.install()).rejects.toThrow("unavailable");
  const refreshing = f.session.refresh();
  f.provider.emit(
    onlyID(f.provider.getState.mock.calls),
    snapshot({ stateRevision: 2, phase: "available" }),
  );
  await refreshing;
  expect(f.session.busy.value).toBe(false);
});

it("waits through installing and reports disk replacement with restart-required", async () => {
  const f = fixture();
  await start(f, snapshot({ phase: "available" }));
  const installing = f.session.install();
  const id = onlyID(f.provider.install.mock.calls);
  f.provider.emit(
    id,
    snapshot({ operationRevision: 1, stateRevision: 2, phase: "installing", installBusy: true }),
  );
  expect(f.session.busy.value).toBe(true);
  await f.session.cancelCheck();
  expect(f.session.ready.value).toBe(true);
  f.provider.emit(
    id,
    snapshot({
      operationRevision: 1,
      stateRevision: 3,
      phase: "installed",
      code: "restart-required",
    }),
  );
  await expect(installing).resolves.toMatchObject({ phase: "installed", code: "restart-required" });
  expect(f.session.busy.value).toBe(false);
});

it("cancelling a check invalidates the session rather than reusing a revoked epoch", async () => {
  const f = fixture();
  await start(f);
  const checking = f.session.check();
  const rejection = expect(checking).rejects.toThrow("ended");
  await f.session.cancelCheck();
  await rejection;
  expect(f.session.ready.value).toBe(false);
  await expect(f.session.check()).rejects.toThrow("unavailable");
  await expect(f.session.start()).rejects.toThrow("ended");
});

it("contains subscription and synchronous command failures and bounds teardown", async () => {
  const f = fixture();
  f.provider.onChange.mockImplementationOnce(() => {
    throw new Error("unavailable");
  });
  await expect(f.session.start()).rejects.toThrow("started");
  const next = fixture();
  await start(next);
  next.provider.check.mockImplementationOnce(() => {
    throw new Error("bridge unavailable");
  });
  await expect(next.session.check()).rejects.toThrow("delivered");
  next.provider.teardown.mockImplementationOnce(() => new Promise<void>(() => {}));
  const cleanup = next.session.dispose();
  await vi.advanceTimersByTimeAsync(20);
  await cleanup;
  expect(next.provider.listeners.size).toBe(0);
});

it("bounds a queued command with no native ack before its longer operation deadline", async () => {
  const f = fixture();
  await start(f);
  const checking = f.session.check();
  const failure = expect(checking).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  await failure;
  expect(f.session.busy.value).toBe(false);
});

it("rejects malformed Begin state and contains an unsubscribe exception", async () => {
  const f = fixture();
  f.provider.onChange.mockImplementationOnce((listener) => {
    f.provider.listeners.add(listener);
    return () => {
      f.provider.listeners.delete(listener);
      throw new Error("unsubscribe failed");
    };
  });
  const starting = f.session.start();
  const failure = expect(starting).rejects.toThrow("Invalid");
  f.provider.emit(onlyID(f.provider.begin.mock.calls), snapshot({ stateRevision: 0 }));
  await failure;
  await f.session.dispose();
  expect(f.session.ready.value).toBe(false);
  expect(f.provider.listeners.size).toBe(0);
});

it("keeps native install busy and a newer install fence when an older error snapshot arrives", async () => {
  const f = fixture();
  await start(f, snapshot({ phase: "available" }));
  const installing = f.session.install();
  f.provider.emit(
    0,
    snapshot({
      stateRevision: 3,
      operationRevision: 1,
      phase: "installing",
      installBusy: true,
    }),
  );
  f.provider.emit(onlyID(f.provider.install.mock.calls), snapshot({ stateRevision: 2 }), "stale");
  await expect(installing).rejects.toThrow("stale");
  expect(f.session.state.value?.installBusy).toBe(true);
  expect(f.session.busy.value).toBe(true);
  await expect(f.session.install()).rejects.toThrow("unavailable");
  const refreshing = f.session.refresh();
  f.provider.emit(
    onlyID(f.provider.getState.mock.calls),
    snapshot({
      stateRevision: 4,
      operationRevision: 1,
      phase: "available",
      installBusy: false,
    }),
  );
  await refreshing;
  expect(f.session.busy.value).toBe(false);
});

it.each(["installed", "error"] as const)(
  "observes the original install %s after a refresh sees it still running",
  async (phase) => {
    const f = fixture();
    await start(f, snapshot({ phase: "available" }));
    f.provider.install.mockRejectedValueOnce(new Error("transport lost"));
    await expect(f.session.install()).rejects.toThrow("delivered");
    const installID = onlyID(f.provider.install.mock.calls);
    const refreshing = f.session.refresh();
    f.provider.emit(
      onlyID(f.provider.getState.mock.calls),
      snapshot({ operationRevision: 1, stateRevision: 2, phase: "installing", installBusy: true }),
    );
    await refreshing;
    expect(f.session.busy.value).toBe(true);
    f.provider.emit(
      installID,
      snapshot({
        operationRevision: 1,
        stateRevision: 3,
        phase,
        code: phase === "installed" ? "restart-required" : "install-failed",
      }),
    );
    expect(f.session.state.value?.phase).toBe(phase);
    expect(f.session.busy.value).toBe(false);
  },
);
