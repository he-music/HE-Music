import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlatformUpdates, UpdatesEvent, UpdatesState } from "@/platform/updates";
import { updatesSession } from "@/platform/updatesSession";

const mocks = vi.hoisted(() => ({
  platform: { lifecycle: {}, updates: undefined as PlatformUpdates | undefined },
  open: vi.fn(async () => {}),
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/mygoUpdateModal", () => ({ openMygoUpdate: mocks.open }));
import { createShellUpdatesSession } from "./shellUpdates";

const cleanups: Array<() => Promise<void>> = [];
function fixture(phase = "idle") {
  const listeners = new Set<(event: UpdatesEvent) => void>();
  const state: UpdatesState = {
    epoch: 3,
    operationRevision: 0,
    stateRevision: 1,
    phase,
    code: "",
    version: "",
    notes: "",
    date: "",
    installBusy: false,
  };
  const emit = (id: number, overrides: Partial<UpdatesState> = {}) => {
    for (const listener of listeners)
      listener({ requestId: id, state: { ...state, ...overrides }, code: "" });
  };
  const provider: PlatformUpdates = {
    begin: vi.fn(async (id) => emit(id)),
    check: vi.fn(async (id, _epoch, revision) =>
      emit(id, {
        operationRevision: revision,
        stateRevision: 2,
        phase: "available",
        version: "2.0.0",
      }),
    ),
    getState: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  mocks.platform.updates = provider;
  const shell = createShellUpdatesSession(() => automatic);
  let automatic = false;
  if (!shell) throw new Error("Missing update shell");
  cleanups.push(() => shell.dispose());
  return {
    shell,
    provider,
    emit,
    automatic: (enabled: boolean) => {
      automatic = enabled;
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(cleanups.splice(0).map((dispose) => dispose()));
  await vi.runAllTimersAsync();
  await cleanup;
  vi.useRealTimers();
  mocks.open.mockClear();
  mocks.platform.updates = undefined;
});

it("starts the owning session without a check when automatic checks are disabled", async () => {
  const f = fixture();
  await f.shell.start();
  expect(updatesSession.value?.ready.value).toBe(true);
  expect(f.provider.check).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("checks once after Ready and presents the available result without installing", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  expect(f.provider.check).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenCalledWith(updatesSession.value);
  expect(f.provider.install).not.toHaveBeenCalled();
});

it("does not automatically check a native unavailable build", async () => {
  const f = fixture("unavailable");
  f.automatic(true);
  await f.shell.start();
  expect(f.provider.check).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("disposal invalidates a pending automatic check and discards its late available result", async () => {
  const f = fixture();
  f.automatic(true);
  let id = 0;
  vi.mocked(f.provider.check).mockImplementationOnce(async (requestID) => {
    id = requestID;
  });
  const starting = f.shell.start();
  const failure = expect(starting).rejects.toThrow("ended");
  for (let n = 0; n < 5; n++) await Promise.resolve();
  expect(f.provider.check).toHaveBeenCalledOnce();
  await f.shell.dispose();
  f.emit(id, { operationRevision: 1, stateRevision: 2, phase: "available" });
  await failure;
  expect(updatesSession.value).toBeUndefined();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("leaves hosts without an updates provider alone", () => {
  mocks.platform.updates = undefined;
  expect(createShellUpdatesSession(() => true)).toBeUndefined();
});
