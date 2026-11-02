import { afterEach, expect, it, vi } from "vitest";
import { onScopeDispose, ref, shallowRef } from "vue";
import * as lifecycle from "@/composables/useSettingLifecycle";
import { mountProductionSfc, flushSfcHost, emitHostEvent } from "@/test/productionSfc";
import type { SettingConfig } from "@/types/settings";

const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
});
function mount(kind: "mygo" | "electron" | "web", initial = "network") {
  const currentRoute = shallowRef({ query: { type: initial } });
  const push = vi.fn(async (route: { path: string; query: { type: string } }) => {
    currentRoute.value = { query: route.query };
  });
  vi.stubGlobal("useRouter", () => ({ currentRoute, push }));
  const locale = ref("zh");
  const samples: {
    key: string;
    enter: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const config = (key: string): SettingConfig => {
    const sample = { key, enter: vi.fn(), leave: vi.fn(), dispose: vi.fn() };
    samples.push(sample);
    onScopeDispose(sample.dispose);
    return {
      groups: [{ title: locale.value, items: [] }],
      onActivate: sample.enter,
      onDeactivate: sample.leave,
    };
  };
  const page = mountProductionSfc(
    new URL("./Setting.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/env": { isElectron: kind === "electron", isMygo: kind === "mygo" },
      "@/composables/useSettingLifecycle": lifecycle,
      "@/components/Setting/config/play": { usePlaySettings: () => config("play") },
      "@/components/Setting/config/general": { useGeneralSettings: () => config("general") },
      "@/components/Setting/config/generalActions": { useGeneralSettingsActions: () => ({}) },
      "@/components/Setting/config/appearance": {
        useAppearanceSettings: () => config("appearance"),
      },
      "@/components/Setting/config/lyric": { useLyricSettings: () => config("lyrics") },
      "@/components/Setting/config/keyboard": { useKeyboardSettings: () => config("keyboard") },
      "@/components/Setting/config/local": { useLocalSettings: () => config("local") },
      "@/components/Setting/config/network": { useNetworkSettings: () => config("network") },
    },
    ["NTabs", "NTabPane", "UniversalSetting", "AboutSetting"],
  );
  close.push(page.close);
  return {
    ...page,
    samples,
    locale,
    push,
    currentRoute,
    latest: (key: string) => samples.filter((sample) => sample.key === key).at(-1)!,
  };
}

it.each(["mygo", "electron", "web"] as const)(
  "exposes desktop tabs only for desktop hosts: %s",
  async (kind) => {
    const page = mount(kind);
    await flushSfcHost();
    const tabs = page
      .all()
      .filter((node) => node.tag === "NTabPane")
      .map((node) => node.props.name);
    expect(tabs.includes("keyboard")).toBe(kind !== "web");
    expect(tabs.includes("local")).toBe(kind !== "web");
  },
);

it("activates only the selected config, replaces locale effects, and deactivates on close", async () => {
  const page = mount("mygo");
  await flushSfcHost();
  const network = page.latest("network");
  expect(network.enter).toHaveBeenCalledOnce();
  expect(page.latest("play").enter).not.toHaveBeenCalled();
  page.currentRoute.value = { query: { type: "play" } };
  await flushSfcHost();
  expect(network.leave).toHaveBeenCalledOnce();
  expect(page.latest("play").enter).toHaveBeenCalledOnce();
  const old = page.latest("play");
  page.locale.value = "en";
  await flushSfcHost();
  expect(old.leave).toHaveBeenCalledOnce();
  expect(old.dispose).toHaveBeenCalledOnce();
  const current = page.latest("play");
  expect(current).not.toBe(old);
  expect(current.enter).toHaveBeenCalledOnce();
  page.close();
  expect(current.leave).toHaveBeenCalledOnce();
  expect(current.dispose).toHaveBeenCalledOnce();
});

it("accepts the old shortcut link and changes tabs through the router once", async () => {
  const page = mount("mygo", "shortcut");
  await flushSfcHost();
  expect(page.latest("keyboard").enter).toHaveBeenCalledOnce();
  const tabs = page.all().find((node) => node.tag === "NTabs");
  if (!tabs) throw new Error("missing tabs");
  emitHostEvent(tabs, "onUpdate:value", "local");
  await flushSfcHost();
  expect(page.push).toHaveBeenCalledExactlyOnceWith({ path: "/setting", query: { type: "local" } });
  expect(page.latest("keyboard").leave).toHaveBeenCalledOnce();
  expect(page.latest("local").enter).toHaveBeenCalledOnce();
});
