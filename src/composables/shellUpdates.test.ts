import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlatformUpdates, UpdatesEvent, UpdatesState } from "@/platform/updates";
import { ref } from "vue";
import packageJson from "@/../package.json";
import { updatesSession } from "@/platform/updatesSession";

const mocks = vi.hoisted(() => ({
  platform: { lifecycle: {}, updates: undefined as PlatformUpdates | undefined },
  open: vi.fn(async () => {}),
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/mygoUpdateModal", () => ({ openMygoUpdate: mocks.open }));
import { createShellUpdatesSession } from "./shellUpdates";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const cleanups: Array<() => Promise<void>> = [];
function fixture(phase = "idle", skippedVersion = ref("")) {
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
    downloaded: 0,
    total: 0,
    installBusy: false,
  };
  const emit = (id: number, overrides: Partial<UpdatesState> = {}) => {
    Object.assign(state, overrides);
    state.stateRevision++;
    for (const listener of listeners) listener({ requestId: id, state: { ...state }, code: "" });
  };
  const provider: PlatformUpdates = {
    begin: vi.fn(async (id) => emit(id)),
    check: vi.fn(async (id, _epoch, revision) =>
      emit(id, {
        operationRevision: revision,
        phase: "available",
        version: "2.0.0",
      }),
    ),
    getState: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  mocks.platform.updates = provider;
  const shell = createShellUpdatesSession(() => automatic, skippedVersion);
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
  vi.restoreAllMocks();
  mocks.platform.updates = undefined;
});

it("starts the owning session without a check when automatic checks are disabled", async () => {
  const f = fixture();
  await f.shell.start();
  expect(updatesSession.value?.ready.value).toBe(true);
  expect(f.provider.check).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("checks once after Ready and keeps the available result without opening a modal or installing", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  expect(f.provider.check).toHaveBeenCalledOnce();
  expect(updatesSession.value?.state.value?.phase).toBe("available");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(f.provider.install).not.toHaveBeenCalled();
});

it("silently checks every six hours without downloading, installing or restarting", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  await vi.advanceTimersByTimeAsync(6 * HOUR - MINUTE);
  expect(f.provider.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * HOUR);
  expect(f.provider.check).toHaveBeenCalledTimes(3);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(f.provider.download).not.toHaveBeenCalled();
  expect(f.provider.install).not.toHaveBeenCalled();
  expect(f.provider.restart).not.toHaveBeenCalled();
});

it("counts the six-hour interval from a manual check", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  await vi.advanceTimersByTimeAsync(5 * HOUR);
  await updatesSession.value?.check();
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * HOUR - MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(3);
});

it("uses the current automatic-check preference without requiring a restart", async () => {
  const f = fixture();
  await f.shell.start();
  await vi.advanceTimersByTimeAsync(6 * HOUR);
  expect(f.provider.check).not.toHaveBeenCalled();
  f.automatic(true);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledOnce();
  f.automatic(false);
  await vi.advanceTimersByTimeAsync(12 * HOUR);
  expect(f.provider.check).toHaveBeenCalledOnce();
  f.automatic(true);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
});

it("defers an overdue check until an ongoing installation has ended", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  f.emit(0, { phase: "installing", installBusy: true });
  await vi.advanceTimersByTimeAsync(7 * HOUR);
  expect(f.provider.check).toHaveBeenCalledOnce();
  f.emit(0, { phase: "cancelled", installBusy: false });
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
});

it("does not replace an installed update that is waiting for a restart", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  f.emit(0, { phase: "installed", code: "restart-required" });
  await vi.advanceTimersByTimeAsync(12 * HOUR);
  expect(f.provider.check).toHaveBeenCalledOnce();
  expect(updatesSession.value?.state.value?.phase).toBe("installed");
});

it("keeps scheduling after a failed background check without retrying every minute", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  vi.mocked(f.provider.check).mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(6 * HOUR);
  expect(report).toHaveBeenCalledWith("后台检查更新失败", expect.any(Error));
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * HOUR - MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(f.provider.check).toHaveBeenCalledTimes(3);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("keeps scheduling if the initial check rejects", async () => {
  const f = fixture();
  f.automatic(true);
  vi.mocked(f.provider.check).mockRejectedValueOnce(new Error("offline"));
  await expect(f.shell.start()).rejects.toThrow("could not be delivered");
  await vi.advanceTimersByTimeAsync(6 * HOUR);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
  expect(updatesSession.value?.state.value?.phase).toBe("available");
});

it("does not create duplicate timers or checks when started twice", async () => {
  const f = fixture();
  f.automatic(true);
  await Promise.all([f.shell.start(), f.shell.start()]);
  expect(f.provider.begin).toHaveBeenCalledOnce();
  expect(f.provider.check).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(6 * HOUR);
  expect(f.provider.check).toHaveBeenCalledTimes(2);
});

it("clears its timer and ignores later preference changes after disposal", async () => {
  const f = fixture();
  f.automatic(true);
  await f.shell.start();
  await f.shell.dispose();
  expect(vi.getTimerCount()).toBe(0);
  f.automatic(false);
  f.automatic(true);
  await vi.advanceTimersByTimeAsync(12 * HOUR);
  expect(f.provider.check).toHaveBeenCalledOnce();
  await expect(f.shell.start()).rejects.toThrow("ended");
});

it("does not automatically check a native unavailable build", async () => {
  const f = fixture("unavailable");
  f.automatic(true);
  await f.shell.start();
  await vi.advanceTimersByTimeAsync(12 * HOUR);
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

it.each(["1.0.0", `v${packageJson.version}`, `${packageJson.version}-beta.1`])(
  "clears the skipped version %s once this installed version has reached it, even with automatic checks off",
  async (version) => {
    const skipped = ref(version);
    const f = fixture("idle", skipped);
    await f.shell.start();
    expect(skipped.value).toBe("");
    expect(f.provider.check).not.toHaveBeenCalled();
  },
);

it("keeps a skipped future version without suppressing automatic version checks", async () => {
  const skipped = ref("99.0.0");
  const f = fixture("idle", skipped);
  f.automatic(true);
  await f.shell.start();
  expect(skipped.value).toBe("99.0.0");
  expect(f.provider.check).toHaveBeenCalledOnce();
});

it("leaves hosts without an updates provider alone", () => {
  mocks.platform.updates = undefined;
  expect(createShellUpdatesSession(() => true)).toBeUndefined();
});
