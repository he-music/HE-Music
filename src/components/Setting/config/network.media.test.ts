import { afterEach, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useNetworkSettings } from "./network";

const fixture = vi.hoisted(() => ({
  platform: { kind: "mygo", networkProxy: { current: vi.fn(), apply: vi.fn(), test: vi.fn() } },
  store: { smtcOpen: true, proxyProtocol: "off", proxyServe: "", proxyPort: 80 },
}));
vi.mock("@/platform", () => ({ platform: fixture.platform }));
vi.mock("@/utils/env", () => ({
  get isElectron() {
    return fixture.platform.kind === "electron";
  },
}));
vi.mock("@/stores", () => ({ useSettingStore: () => fixture.store }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(() => vi.clearAllMocks());

it.each(["mygo", "electron", "web"])("keeps the media switch available for %s", (kind) => {
  fixture.platform.kind = kind;
  fixture.store.smtcOpen = true;
  const scope = effectScope();
  const config = scope.run(useNetworkSettings);
  const item = config?.groups
    .flatMap((group) => group.items)
    .find((item) => item.key === "smtcOpen");
  if (!item?.value) throw new Error("missing media switch");
  expect(item.value.value).toBe(true);
  item.value.value = false;
  expect(fixture.store.smtcOpen).toBe(false);
  expect(fixture.platform.networkProxy.current).not.toHaveBeenCalled();
  scope.stop();
});
