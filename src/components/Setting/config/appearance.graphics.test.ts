import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isRef, toValue } from "vue";
import {
  LinuxGraphicsSession,
  linuxGraphicsSession,
  type LinuxGraphicsState,
} from "@/platform/linuxGraphics";
import { useAppearanceSettings } from "./appearance";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", os: "linux", linuxGraphics: {}, windowAppearance: undefined },
}));
vi.mock("@/stores", () => ({ useSettingStore: () => ({}), useStatusStore: () => ({}) }));
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/utils/env", () => ({ isElectron: false }));
vi.mock("@/utils/modal", () => ({ openFontManager: vi.fn(), openThemeConfig: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
const snapshot = (enabled = false, applied = false): LinuxGraphicsState => ({
  enabled,
  applied,
  restartRequired: enabled !== applied,
  loadFailed: false,
});
const provider = {
  current: vi.fn(async () => snapshot()),
  save: vi.fn(async (enabled: boolean) => snapshot(enabled)),
};
const sessions: LinuxGraphicsSession[] = [];
function control() {
  const config = useAppearanceSettings();
  const item = config.groups
    .flatMap((group) => group.items)
    .find((item) => item.key === "linuxGraphicsCompatibility");
  if (!item) throw new Error("Missing production Linux graphics setting");
  return { config, item };
}
function set(item: ReturnType<typeof control>["item"], enabled: boolean) {
  if (!isRef(item.value)) throw new Error("Missing graphics setting value");
  item.value.value = enabled;
}
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
beforeEach(() => {
  mocks.platform.kind = "mygo";
  mocks.platform.os = "linux";
  provider.current.mockResolvedValue(snapshot());
  provider.save.mockImplementation(async (enabled) => snapshot(enabled));
  vi.stubGlobal("window", { $message: messages });
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("Linux setting construction is lazy and disabled before a native snapshot", () => {
  const { item } = control();
  expect(toValue(item.show)).toBe(true);
  expect(toValue(item.disabled)).toBe(true);
  expect(provider.current).not.toHaveBeenCalled();
});
it.each([
  ["web", "linux"],
  ["electron", "linux"],
  ["mygo", "darwin"],
  ["mygo", "win32"],
])("hides Linux graphics preference on %s/%s", (kind, os) => {
  mocks.platform.kind = kind;
  mocks.platform.os = os;
  expect(toValue(control().item.show)).toBe(false);
  expect(provider.current).not.toHaveBeenCalled();
});
it("saves the next-launch choice and reports restart without changing the applied mode", async () => {
  const session = new LinuxGraphicsSession(provider);
  sessions.push(session);
  await session.start();
  const { config, item } = control();
  await config.onActivate?.();
  expect(toValue(item.disabled)).toBe(false);
  set(item, true);
  await flush();
  expect(provider.save).toHaveBeenCalledExactlyOnceWith(true);
  expect(session.state.value).toEqual(snapshot(true));
  expect(toValue(item.value)).toBe(true);
  expect(session.state.value?.applied).toBe(false);
  expect(messages.warning).toHaveBeenCalledWith("message.setting_saved_and_restart_required");
  config.onDeactivate?.();
});
it("save failures preserve the previous choice", async () => {
  const session = new LinuxGraphicsSession(provider);
  sessions.push(session);
  await session.start();
  const { config, item } = control();
  await config.onActivate?.();
  provider.save.mockRejectedValueOnce(new Error("synthetic write failure"));
  set(item, true);
  await flush();
  expect(toValue(item.value)).toBe(false);
  expect(messages.error).toHaveBeenCalledWith("mygo.linux_graphics.save_failed");
  config.onDeactivate?.();
});
it("late replies from a replaced shell cannot overwrite the active graphics session", async () => {
  let reply!: (state: LinuxGraphicsState) => void;
  provider.current.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const old = new LinuxGraphicsSession(provider);
  sessions.push(old);
  const pending = old.start();
  old.dispose();
  const current = new LinuxGraphicsSession(provider);
  sessions.push(current);
  await current.start();
  reply(snapshot(true, true));
  await pending;
  expect(linuxGraphicsSession.value).toBe(current);
  expect(current.state.value).toEqual(snapshot());
  expect(old.state.value).toBeUndefined();
});
