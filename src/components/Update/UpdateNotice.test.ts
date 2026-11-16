import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import type { UpdatesState } from "@/platform/updates";

const state = shallowRef<UpdatesState>();
const check = vi.fn(async () => {});
const error = vi.fn();
const cleanups: Array<() => void> = [];
function mount() {
  const host = mountProductionSfc(
    new URL("./UpdateNotice.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/platform/updates": { updatesState: state },
      "@/platform": { platform: { updates: { check } } },
    },
    ["NButton", "SvgIcon"],
  );
  cleanups.push(host.close);
  return { ...host, button: () => host.all().find((node) => node.tag === "NButton") };
}
beforeEach(() => {
  state.value = { revision: 1, availableVersion: "2.0.4", installed: false };
  check.mockReset();
  error.mockReset();
  vi.stubGlobal("window", { $message: { error } });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

it("opens the official window and shows its ready-to-restart state", async () => {
  const host = mount();
  const button = host.button();
  expect(button?.props["aria-label"]).toContain("updates.available_short");
  if (!button) throw new Error("Missing update notice");
  emitHostEvent(button, "onClick");
  await flushSfcHost();
  expect(check).toHaveBeenCalledOnce();
  state.value = { revision: 2, availableVersion: "2.0.4", installed: true };
  await flushSfcHost();
  expect(host.button()?.props["aria-label"]).toContain("updates.restart");
});

it("hides when the plugin has no offered version or the page disconnects", async () => {
  const host = mount();
  state.value = { revision: 2, availableVersion: "", installed: false };
  await flushSfcHost();
  expect(host.button()).toBeUndefined();
  state.value = undefined;
  await flushSfcHost();
  expect(host.button()).toBeUndefined();
});

it("reports a failed request to open the official window", async () => {
  check.mockRejectedValueOnce(new Error("native failure"));
  const host = mount();
  const button = host.button();
  if (!button) throw new Error("Missing update notice");
  emitHostEvent(button, "onClick");
  await flushSfcHost();
  expect(error).toHaveBeenCalledWith("updates.open_failed");
});
