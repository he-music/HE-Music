import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isRef, toValue } from "vue";
import {
  WindowAppearanceSession,
  windowAppearanceSession,
  type WindowAppearanceState,
} from "@/platform/windowAppearance";
import { useAppearanceSettings } from "./appearance";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", windowAppearance: {} },
  setting: {} as Record<string, unknown>,
}));
vi.mock("@/stores", () => ({ useSettingStore: () => mocks.setting, useStatusStore: () => ({}) }));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/env", () => ({ isElectron: false }));
vi.mock("@/utils/modal", () => ({ openFontManager: vi.fn(), openThemeConfig: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
const snapshot = (desired = false): WindowAppearanceState => ({
  useBorderless: desired,
  appliedUseBorderless: false,
  restartRequired: desired,
  loadFailed: false,
});
const sessions: WindowAppearanceSession[] = [];
const provider = {
  current: vi.fn(async () => snapshot()),
  save: vi.fn(async (desired: boolean) => snapshot(desired)),
};
function borderless() {
  const config = useAppearanceSettings();
  const item = config.groups
    .flatMap((group) => group.items)
    .find((item) => item.key === "useBorderless");
  if (!item) throw new Error("Missing production borderless setting");
  return { config, item };
}
function set(item: ReturnType<typeof borderless>["item"], value: boolean) {
  if (!isRef(item.value)) throw new Error("Missing setting value");
  item.value.value = value;
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
beforeEach(() => {
  provider.current.mockResolvedValue(snapshot());
  provider.save.mockImplementation(async (desired) => snapshot(desired));
  vi.stubGlobal("window", { $message: messages });
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("search construction performs no native IO and keeps an unavailable shell disabled", () => {
  const { item } = borderless();
  expect(provider.current).not.toHaveBeenCalled();
  expect(provider.save).not.toHaveBeenCalled();
  expect(toValue(item.disabled)).toBe(true);
});
it("the actual switch saves next-launch state, shows restart feedback and leaves applied state unchanged", async () => {
  const session = new WindowAppearanceSession(provider);
  sessions.push(session);
  await session.start();
  const { config, item } = borderless();
  await config.onActivate?.();
  expect(toValue(item.disabled)).toBe(false);
  set(item, true);
  await flush();
  expect(provider.save).toHaveBeenCalledExactlyOnceWith(true);
  expect(session.state.value).toEqual(snapshot(true));
  expect(messages.warning).toHaveBeenCalledExactlyOnceWith(
    "message.setting_saved_and_restart_required",
  );
  expect(session.state.value?.appliedUseBorderless).toBe(false);
  set(item, false);
  await flush();
  expect(messages.success).toHaveBeenCalledExactlyOnceWith("mygo.window_appearance.saved");
  config.onDeactivate?.();
});
it("late failure after leaving the settings panel preserves state and does not report into the next panel", async () => {
  let fail: (error: Error) => void = () => {
    throw new Error("missing save");
  };
  provider.save.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const session = new WindowAppearanceSession(provider);
  sessions.push(session);
  await session.start();
  const { config, item } = borderless();
  await config.onActivate?.();
  set(item, true);
  config.onDeactivate?.();
  fail(new Error("synthetic write failure"));
  await flush();
  expect(session.state.value).toEqual(snapshot());
  expect(messages.error).not.toHaveBeenCalled();
  expect(windowAppearanceSession.value).toBe(session);
});
