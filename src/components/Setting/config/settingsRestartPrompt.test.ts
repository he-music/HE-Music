import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSettingsRestartPrompt } from "./settingsRestartPrompt";

const mocks = vi.hoisted(() => ({ lifecycle: { restart: vi.fn(async () => {}) } }));
vi.mock("@/platform", () => ({ platform: { lifecycle: mocks.lifecycle } }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

type Confirmation = {
  content: string;
  positiveText: string;
  negativeText: string;
  onPositiveClick(): Promise<unknown>;
  onNegativeClick(): void;
  onClose(): void;
  onAfterLeave(): void;
};
const warning = vi.fn((options: Confirmation) => ({
  ...options,
  loading: false,
  destroy: vi.fn(),
}));
const error = vi.fn();
const confirmation = () => warning.mock.calls.at(-1)![0];

beforeEach(() => {
  mocks.lifecycle.restart.mockResolvedValue();
  vi.stubGlobal("window", { $dialog: { warning }, $message: { error } });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("offers restart or later only while the saved setting still requires restart", async () => {
  const prompt = createSettingsRestartPrompt();
  prompt.show(() => false);
  expect(warning).not.toHaveBeenCalled();
  prompt.show(() => true);
  expect(confirmation()).toMatchObject({
    content: "message.setting_saved_and_restart_required",
    positiveText: "common.restart_now",
    negativeText: "common.later",
  });
  expect(mocks.lifecycle.restart).not.toHaveBeenCalled();
  await confirmation().onPositiveClick();
  expect(mocks.lifecycle.restart).toHaveBeenCalledOnce();
});

it.each(["onNegativeClick", "onClose", "onAfterLeave"] as const)(
  "%s leaves settings saved and makes an old restart callback inert",
  async (action) => {
    const prompt = createSettingsRestartPrompt();
    prompt.show(() => true);
    const old = confirmation();
    old[action]();
    await old.onPositiveClick();
    expect(mocks.lifecycle.restart).not.toHaveBeenCalled();
  },
);

it("dismissal and replacement invalidate old buttons without dismissing the new prompt", async () => {
  const prompt = createSettingsRestartPrompt();
  prompt.show(() => true);
  const old = confirmation();
  const oldDialog = warning.mock.results[0].value;
  prompt.dismiss();
  expect(oldDialog.destroy).toHaveBeenCalledOnce();
  prompt.show(() => true, "mygo.proxy.restart");
  old.onAfterLeave();
  await old.onPositiveClick();
  expect(mocks.lifecycle.restart).not.toHaveBeenCalled();
  expect(confirmation().content).toBe("mygo.proxy.restart");
  await confirmation().onPositiveClick();
  expect(mocks.lifecycle.restart).toHaveBeenCalledOnce();
});

it("checks the live state again before restarting", async () => {
  let required = true;
  const prompt = createSettingsRestartPrompt();
  prompt.show(() => required);
  required = false;
  await confirmation().onPositiveClick();
  expect(mocks.lifecycle.restart).not.toHaveBeenCalled();
});

it("prevents duplicate restarts and permits retry after a restart failure", async () => {
  let fail!: (error: Error) => void;
  mocks.lifecycle.restart.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (fail = reject)),
  );
  const prompt = createSettingsRestartPrompt();
  prompt.show(() => true);
  const dialog = warning.mock.results[0].value;
  const first = confirmation().onPositiveClick();
  expect(dialog.loading).toBe(true);
  await confirmation().onPositiveClick();
  expect(mocks.lifecycle.restart).toHaveBeenCalledOnce();
  fail(new Error("restart failed"));
  expect(await first).toBe(false);
  expect(error).toHaveBeenCalledExactlyOnceWith("message.restart_failed");
  expect(dialog.loading).toBe(false);
  await confirmation().onPositiveClick();
  expect(mocks.lifecycle.restart).toHaveBeenCalledTimes(2);
});

it("does not report a late restart failure after the settings panel leaves", async () => {
  let fail!: (error: Error) => void;
  mocks.lifecycle.restart.mockImplementationOnce(
    () => new Promise((_resolve, reject) => (fail = reject)),
  );
  const prompt = createSettingsRestartPrompt();
  prompt.show(() => true);
  const pending = confirmation().onPositiveClick();
  prompt.dismiss();
  fail(new Error("owner left"));
  await pending;
  expect(error).not.toHaveBeenCalled();
});
