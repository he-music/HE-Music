import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reactive, ref, shallowRef } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import { useUpdateProgress } from "@/composables/useUpdateProgress";
import type { UpdatesState } from "@/platform/updates";

const setting = reactive({ skippedUpdateVersion: "" });
const state = shallowRef<UpdatesState>();
const ready = ref(true);
const session = { ready, state };
const current = shallowRef<typeof session>();
const open = vi.fn(async () => {});
const error = vi.fn();
const cleanups: Array<() => void> = [];
const candidate = (phase: string, extra: Partial<UpdatesState> = {}): UpdatesState => ({
  epoch: 1,
  operationRevision: 1,
  stateRevision: 1,
  phase,
  code: "",
  version: "2.0.4",
  notes: "",
  date: "",
  downloaded: 0,
  total: 0,
  installBusy: phase === "installing",
  ...extra,
});
function mount() {
  const host = mountProductionSfc(
    new URL("./UpdateNotice.vue", import.meta.url),
    {
      "vue-i18n": {
        useI18n: () => ({
          t: (key: string, data?: { percent?: number }) => (data ? `${key}:${data.percent}` : key),
        }),
      },
      "@/stores": { useSettingStore: () => setting },
      "@/platform/updatesSession": { updatesSession: current },
      "@/composables/useUpdateProgress": { useUpdateProgress },
      "@/utils/mygoUpdateModal": { openMygoUpdate: open },
    },
    ["NButton", "SvgIcon"],
  );
  cleanups.push(host.close);
  return { ...host, button: () => host.all().find((node) => node.tag === "NButton") };
}
beforeEach(() => {
  current.value = session;
  ready.value = true;
  setting.skippedUpdateVersion = "";
  state.value = candidate("available");
  open.mockReset();
  error.mockReset();
  vi.stubGlobal("window", { $message: { error } });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

it("hides only the skipped candidate, offers a newer version, and opens details on demand", async () => {
  setting.skippedUpdateVersion = "2.0.4";
  const host = mount();
  expect(host.button()).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  state.value = candidate("available", { version: "2.0.5" });
  await flushSfcHost();
  const button = host.button();
  expect(button?.props["aria-label"]).toContain("updates.available_short");
  if (!button) throw new Error("Missing update notice");
  emitHostEvent(button, "onClick");
  await flushSfcHost();
  expect(open).toHaveBeenCalledExactlyOnceWith(session);
});

it("keeps progress and restart accessible even for a previously skipped version", async () => {
  setting.skippedUpdateVersion = "2.0.4";
  state.value = candidate("installing", { downloaded: 50, total: 100 });
  const host = mount();
  expect(host.button()?.props["aria-label"]).toContain("updates.downloading:50");
  state.value = candidate("installing", { downloaded: 100, total: 100 });
  await flushSfcHost();
  expect(host.button()?.props["aria-label"]).toContain("updates.finishing");
  expect(host.button()?.props["aria-label"]).not.toContain("100");
  state.value = candidate("installed");
  await flushSfcHost();
  expect(host.button()?.props["aria-label"]).toContain("updates.restart");
  expect(open).not.toHaveBeenCalled();
});

it("uses no percentage for unknown sizes and keeps failed installations accessible", async () => {
  state.value = candidate("installing", { downloaded: 50 });
  const host = mount();
  expect(host.button()?.props["aria-label"]).toContain("updates.downloading_unknown");
  state.value = candidate("error", { code: "install-failed" });
  await flushSfcHost();
  expect(host.button()?.props["aria-label"]).toContain("updates.failed");
  state.value = candidate("error", { code: "check-failed" });
  await flushSfcHost();
  expect(host.button()).toBeUndefined();
});

it("removes the notice when its native session ends", async () => {
  const host = mount();
  expect(host.button()).toBeDefined();
  ready.value = false;
  await flushSfcHost();
  expect(host.button()).toBeUndefined();
  ready.value = true;
  current.value = undefined;
  await flushSfcHost();
  expect(host.button()).toBeUndefined();
});

it("reports an error if opening update details fails", async () => {
  open.mockRejectedValueOnce(new Error("load failed"));
  const host = mount();
  const button = host.button();
  if (!button) throw new Error("Missing update notice");
  emitHostEvent(button, "onClick");
  await flushSfcHost();
  expect(error).toHaveBeenCalledWith("updates.open_failed");
});
