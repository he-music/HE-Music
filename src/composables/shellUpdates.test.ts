import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { PlatformUpdates, UpdatesState } from "@/platform/updates";
import { updatesState } from "@/platform/updates";

const mocks = vi.hoisted(() => ({
  platform: { lifecycle: {}, updates: undefined as PlatformUpdates | undefined },
}));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
import { createShellUpdatesSession } from "./shellUpdates";

const cleanups: Array<() => Promise<void>> = [];
const status = (revision = 1, availableVersion = ""): UpdatesState => ({
  revision,
  availableVersion,
  installed: false,
});
function fixture() {
  const automatic = ref(true);
  const listeners = new Set<(state: UpdatesState) => void>();
  const provider: PlatformUpdates = {
    getState: vi.fn(async () => status()),
    configure: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  mocks.platform.updates = provider;
  const shell = createShellUpdatesSession(() => automatic.value);
  if (!shell) throw new Error("Missing update shell");
  cleanups.push(() => shell.dispose());
  return {
    shell,
    automatic,
    provider,
    emit: (state: UpdatesState) => listeners.forEach((f) => f(state)),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.useRealTimers();
  mocks.platform.updates = undefined;
});

it("leaves scheduling and installation to the plugin and synchronizes settings", async () => {
  const f = fixture();
  const first = f.shell.start();
  expect(f.shell.start()).toBe(first);
  await first;
  expect(f.provider.configure).toHaveBeenCalledExactlyOnceWith(true);
  expect(updatesState.value).toEqual(status());
  f.automatic.value = false;
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  expect(f.provider.configure).toHaveBeenLastCalledWith(false);
  expect(f.provider.getState).toHaveBeenCalledOnce();
  expect(f.provider.check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overwrite a newer event with a late state response", async () => {
  const f = fixture();
  let resolve!: (state: UpdatesState) => void;
  vi.mocked(f.provider.getState).mockImplementationOnce(
    () =>
      new Promise((finish) => {
        resolve = finish;
      }),
  );
  const starting = f.shell.start();
  f.emit(status(3, "2.0.4"));
  resolve(status(1));
  await starting;
  expect(updatesState.value?.availableVersion).toBe("2.0.4");
  f.emit(status(2));
  expect(updatesState.value?.availableVersion).toBe("2.0.4");
});

it("disposal ignores late results and does not stop the plugin's application-owned work", async () => {
  const f = fixture();
  let resolve!: (state: UpdatesState) => void;
  vi.mocked(f.provider.getState).mockImplementationOnce(
    () =>
      new Promise((finish) => {
        resolve = finish;
      }),
  );
  const starting = f.shell.start();
  await f.shell.dispose();
  resolve(status(3, "2.0.4"));
  await starting;
  expect(updatesState.value).toBeUndefined();
  expect(f.provider.configure).not.toHaveBeenCalled();
  f.automatic.value = false;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.provider.configure).not.toHaveBeenCalled();
});

it("an old shell cannot clear the state of its replacement", async () => {
  const old = fixture();
  await old.shell.start();
  const next = fixture();
  await next.shell.start();
  next.emit(status(5, "2.0.5"));
  await old.shell.dispose();
  expect(updatesState.value?.availableVersion).toBe("2.0.5");
});

it("does not register an update shell on the web", () => {
  expect(createShellUpdatesSession(() => true)).toBeUndefined();
});
