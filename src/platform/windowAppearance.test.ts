import { afterEach, expect, it, vi } from "vitest";
import {
  WindowAppearanceSession,
  windowAppearanceSession,
  type PlatformWindowAppearance,
  type WindowAppearanceState,
} from "./windowAppearance";

const nativeState = (desired = false, applied = false): WindowAppearanceState => ({
  useBorderless: desired,
  appliedUseBorderless: applied,
  restartRequired: desired !== applied,
  loadFailed: false,
});
const sessions: WindowAppearanceSession[] = [];
function session(provider: PlatformWindowAppearance) {
  const value = new WindowAppearanceSession(provider);
  sessions.push(value);
  return value;
}
afterEach(() => {
  sessions.splice(0).forEach((value) => value.dispose());
});

it("saves next-start choices while keeping the current window appearance stable", async () => {
  const provider = {
    current: vi.fn(async () => nativeState()),
    save: vi.fn(async (value: boolean) => nativeState(value)),
  };
  const active = session(provider);
  await active.start();
  expect(windowAppearanceSession.value).toBe(active);
  await active.save(true);
  expect(active.state.value).toEqual(nativeState(true));
  expect(active.state.value?.appliedUseBorderless).toBe(false);
  await active.save(false);
  expect(active.state.value?.restartRequired).toBe(false);
});

it("rejects a retired owner's late read and save without clearing the replacement shell", async () => {
  let read: (value: WindowAppearanceState) => void = () => {
    throw new Error("missing read");
  };
  const old = session({
    current: () =>
      new Promise((resolve) => {
        read = resolve;
      }),
    save: vi.fn(),
  });
  const loading = old.start();
  old.dispose();
  const replacement = session({
    current: async () => nativeState(true, true),
    save: async () => nativeState(false, true),
  });
  await replacement.start();
  read(nativeState());
  await loading;
  expect(old.state.value).toBeUndefined();
  expect(windowAppearanceSession.value).toBe(replacement);

  let save: (value: WindowAppearanceState) => void = () => {
    throw new Error("missing save");
  };
  const savingOwner = session({
    current: async () => nativeState(),
    save: () =>
      new Promise((resolve) => {
        save = resolve;
      }),
  });
  await savingOwner.start();
  const saving = savingOwner.save(true);
  savingOwner.dispose();
  await replacement.start();
  save(nativeState(true));
  expect(await saving).toBeUndefined();
  expect(windowAppearanceSession.value).toBe(replacement);
  expect(replacement.state.value).toEqual(nativeState(true, true));
});

it("serializes saves and preserves the saved state when native persistence fails", async () => {
  let fail: (error: Error) => void = () => {
    throw new Error("missing rejection");
  };
  const provider = {
    current: vi.fn(async () => nativeState()),
    save: vi.fn(
      () =>
        new Promise<WindowAppearanceState>((_resolve, reject) => {
          fail = reject;
        }),
    ),
  };
  const active = session(provider);
  await active.start();
  const saving = active.save(true);
  expect(active.saving.value).toBe(true);
  expect(await active.save(false)).toBeUndefined();
  expect(provider.save).toHaveBeenCalledOnce();
  fail(new Error("synthetic disk failure"));
  await expect(saving).rejects.toThrow("synthetic disk failure");
  expect(active.saving.value).toBe(false);
  expect(active.state.value).toEqual(nativeState());
});
