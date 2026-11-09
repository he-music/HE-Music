import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { capturePreferencesResetFilesOwner } from "@/platform/preferencesResetOwner";
import type { PreferencesResetMode, PreferencesResetReceipt } from "@/platform/preferencesReset";
import { effectScope } from "vue";
import { usePreferencesResetActions } from "./preferencesResetActions";

const mocks = vi.hoisted(() => ({
  resetSettings: vi.fn(),
  deleteDB: vi.fn(async () => {}),
  disposeFiles: vi.fn(async () => {}),
  dropInstance: vi.fn<(options: { name: string; storeName: string }) => Promise<void>>(
    async () => {},
  ),
}));
vi.mock("localforage", () => ({ default: { dropInstance: mocks.dropInstance } }));
vi.mock("@/stores", () => ({
  useSettingStore: () => ({ $reset: mocks.resetSettings }),
  useDataStore: () => ({ deleteDB: mocks.deleteDB }),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

interface Confirmation {
  content: string;
  onPositiveClick(): Promise<void>;
  onNegativeClick(): void;
  onClose(): void;
  onAfterLeave(): void;
}
let dialog: Confirmation | undefined;
const scopes: ReturnType<typeof effectScope>[] = [];
let activeOwner: object | undefined;
let ownerGeneration = 0;
const error = vi.fn();
const success = vi.fn();
const clearLocal = vi.fn();
const clearSession = vi.fn();
const native = {
  reset: vi.fn(async (mode: PreferencesResetMode): Promise<PreferencesResetReceipt> => ({
    pending: true,
    restartRequired: true,
    transactionId: "tx",
    mode,
  })),
};
const lifecycle = { restart: vi.fn(async () => {}) };

beforeEach(() => {
  vi.resetAllMocks();
  native.reset.mockImplementation(async (mode) => ({
    pending: true,
    restartRequired: true,
    transactionId: "tx",
    mode,
  }));
  mocks.deleteDB.mockResolvedValue();
  mocks.disposeFiles.mockResolvedValue();
  mocks.dropInstance.mockResolvedValue();
  lifecycle.restart.mockResolvedValue();
  dialog = undefined;
  vi.stubGlobal("window", {
    $dialog: {
      warning: (options: Confirmation) => {
        dialog = options;
      },
    },
    $message: { error, success },
    localStorage: { clear: clearLocal },
    sessionStorage: { clear: clearSession },
  });
});
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.unstubAllGlobals();
});
function setup() {
  const scope = effectScope();
  scopes.push(scope);
  const capturedOwner = {};
  activeOwner = capturedOwner;
  ownerGeneration++;
  const owner = capturePreferencesResetFilesOwner({
    ownsEpoch: () => activeOwner === capturedOwner,
    registryGeneration: () => ownerGeneration,
    registryEmpty: () => activeOwner === undefined,
    dispose: () => {
      activeOwner = undefined;
      ownerGeneration++;
      return mocks.disposeFiles();
    },
  });
  const actions = scope.run(() => usePreferencesResetActions(native, lifecycle, owner));
  if (!actions) throw new Error("Missing actions");
  return { scope, actions };
}
function confirmation() {
  if (!dialog) throw new Error("Missing confirmation");
  return dialog;
}

it("cancellation and dismissal do not touch native, renderer or file sessions", async () => {
  const { actions } = setup();
  actions.request("settings");
  const cancelled = confirmation();
  expect(actions.disabled.value).toBe(true);
  cancelled.onNegativeClick();
  cancelled.onAfterLeave();
  await cancelled.onPositiveClick();
  expect(actions.disabled.value).toBe(false);
  actions.request("all");
  confirmation().onClose();
  await confirmation().onPositiveClick();
  expect(native.reset).not.toHaveBeenCalled();
  expect(mocks.disposeFiles).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(mocks.resetSettings).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
});

it("settings reset preserves renderer history and awaits file cleanup before restart", async () => {
  const { actions } = setup();
  let finish: (() => void) | undefined;
  mocks.disposeFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("settings");
  expect(confirmation().content).toBe("mygo.reset_settings_confirm");
  const task = confirmation().onPositiveClick();
  await vi.waitFor(() => expect(mocks.disposeFiles).toHaveBeenCalledOnce());
  expect(mocks.resetSettings).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  finish?.();
  await task;
  expect(mocks.resetSettings).toHaveBeenCalledOnce();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(clearSession).not.toHaveBeenCalled();
  expect(mocks.deleteDB).not.toHaveBeenCalled();
  expect(mocks.dropInstance).not.toHaveBeenCalled();
  expect(lifecycle.restart).toHaveBeenCalledOnce();
  expect(success).toHaveBeenCalledWith("mygo.reset_scheduled");
  await confirmation().onPositiveClick();
  expect(native.reset).toHaveBeenCalledOnce();
});

it("clear all awaits renderer database clearing before restarting", async () => {
  const { actions } = setup();
  let finish: (() => void) | undefined;
  mocks.deleteDB.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("all");
  expect(confirmation().content).toBe("mygo.reset_all_confirm");
  const task = confirmation().onPositiveClick();
  await vi.waitFor(() => expect(mocks.deleteDB).toHaveBeenCalledOnce());
  expect(clearLocal).toHaveBeenCalledOnce();
  expect(clearSession).toHaveBeenCalledOnce();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  finish?.();
  await task;
  expect(lifecycle.restart).toHaveBeenCalledOnce();
  expect(mocks.resetSettings).not.toHaveBeenCalled();
});

it("native failure leaves renderer intact and allows a fresh confirmed retry", async () => {
  const { actions } = setup();
  native.reset.mockRejectedValueOnce(new Error("disk full"));
  actions.request("all");
  await confirmation().onPositiveClick();
  expect(error).toHaveBeenCalledWith("mygo.reset_native_failed");
  expect(success).not.toHaveBeenCalled();
  expect(mocks.disposeFiles).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(mocks.deleteDB).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  expect(actions.disabled.value).toBe(false);
  actions.request("all");
  await confirmation().onPositiveClick();
  expect(native.reset).toHaveBeenCalledTimes(2);
  expect(mocks.deleteDB).toHaveBeenCalledOnce();
});

it("partial clear and restart failures report scheduled reset honestly", async () => {
  const { actions } = setup();
  mocks.deleteDB.mockRejectedValueOnce(new Error("IndexedDB"));
  lifecycle.restart.mockRejectedValueOnce(new Error("owner lost"));
  actions.request("all");
  await confirmation().onPositiveClick();
  expect(error.mock.calls).toEqual([["mygo.reset_renderer_failed"], ["mygo.reset_restart_failed"]]);
  expect(success).not.toHaveBeenCalled();
  expect(actions.disabled.value).toBe(true);
});

it("a disposed settings owner cannot clear or restart after a pending native call", async () => {
  const { scope, actions } = setup();
  let finish: ((receipt: PreferencesResetReceipt) => void) | undefined;
  native.reset.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("all");
  const task = confirmation().onPositiveClick();
  scope.stop();
  finish?.({ pending: true, restartRequired: true, transactionId: "tx", mode: "all" });
  await task;
  expect(mocks.disposeFiles).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});

it("a cache drop failure is partial failure, never success or automatic destructive retry", async () => {
  const { actions } = setup();
  mocks.dropInstance.mockRejectedValueOnce(new Error("database blocked"));
  actions.request("all");
  await confirmation().onPositiveClick();
  expect(mocks.dropInstance).toHaveBeenCalledExactlyOnceWith({
    name: "local-data",
    storeName: "local_download_history",
  });
  expect(error).toHaveBeenCalledWith("mygo.reset_renderer_failed");
  expect(success).not.toHaveBeenCalled();
  expect(lifecycle.restart).toHaveBeenCalledOnce();
  await confirmation().onPositiveClick();
  expect(mocks.dropInstance).toHaveBeenCalledTimes(1);
});

it("native await replacement never disposes the new files owner", async () => {
  const { actions } = setup();
  let finish: ((receipt: PreferencesResetReceipt) => void) | undefined;
  native.reset.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("all");
  const task = confirmation().onPositiveClick();
  const replacement = { dispose: vi.fn() };
  activeOwner = replacement;
  ownerGeneration++;
  finish?.({ pending: true, restartRequired: true, transactionId: "tx", mode: "all" });
  await task;
  expect(replacement.dispose).not.toHaveBeenCalled();
  expect(mocks.disposeFiles).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});

it("owner replacement during captured dispose wait prevents renderer clearing and restart", async () => {
  const { actions } = setup();
  let finish: (() => void) | undefined;
  mocks.disposeFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("all");
  const task = confirmation().onPositiveClick();
  await vi.waitFor(() => expect(mocks.disposeFiles).toHaveBeenCalledOnce());
  const replacement = { dispose: vi.fn() };
  activeOwner = replacement;
  ownerGeneration++;
  finish?.();
  await task;
  expect(replacement.dispose).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(mocks.deleteDB).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it("a stale confirmation cannot commit native reset after its file owner was replaced", async () => {
  const { actions } = setup();
  actions.request("all");
  activeOwner = { dispose: vi.fn() };
  ownerGeneration++;
  await confirmation().onPositiveClick();
  expect(native.reset).not.toHaveBeenCalled();
  expect(mocks.disposeFiles).not.toHaveBeenCalled();
  expect(clearLocal).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
});

it("replacement during an already-started database clear prevents further cache drops", async () => {
  const { actions } = setup();
  let finish: (() => void) | undefined;
  mocks.deleteDB.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  actions.request("all");
  const task = confirmation().onPositiveClick();
  await vi.waitFor(() => expect(mocks.deleteDB).toHaveBeenCalledOnce());
  activeOwner = {};
  ownerGeneration++;
  finish?.();
  await task;
  expect(mocks.dropInstance).not.toHaveBeenCalled();
  expect(lifecycle.restart).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
});
