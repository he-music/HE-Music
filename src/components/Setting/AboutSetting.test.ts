import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ref, shallowRef } from "vue";
import { debounce } from "lodash-es";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const ready = ref(true);
const busy = ref(false);
const state = ref({ phase: "available" });
const check = vi.fn(async () => {});
const session = { ready, busy, state, check };
const current = shallowRef<typeof session | undefined>(session);
const open = vi.fn(async () => {});
const message = { success: vi.fn(), error: vi.fn() };
const cleanups: Array<() => void> = [];
function mount() {
  const host = mountProductionSfc(
    new URL("./AboutSetting.vue", import.meta.url),
    {
      "@/utils/helper": { openLink: vi.fn() },
      "@/utils/updateLog": { getUpdateLog: async () => [] },
      "lodash-es": { debounce },
      "@/stores": { useStatusStore: () => ({ updateCheck: false }) },
      "github-markdown-css/github-markdown.css": {},
      "@/../package.json": { default: { version: "1.0.4", github: "https://github.test/music" } },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/env": { isElectron: false },
      "@/platform": { platform: { kind: "mygo" } },
      "@/platform/updatesSession": { updatesSession: current },
      "@/utils/mygoUpdateModal": { openMygoUpdate: open },
      "@/constants/links": { MOBILE_APP_RELEASE_URL: "https://github.test/mobile" },
    },
    [
      "NH3",
      "NCard",
      "NFlex",
      "SvgIcon",
      "NText",
      "NTag",
      "NButton",
      "NCollapseTransition",
      "NCollapse",
      "NCollapseItem",
    ],
    'import { computed, ref, onMounted, onScopeDispose } from "vue";',
  );
  cleanups.push(host.close);
  const text = (node: ReturnType<typeof host.all>[number]): string =>
    node.text + node.children.map(text).join("");
  const button = () =>
    host
      .all()
      .find((node) => node.tag === "NButton" && text(node).includes("setting.about.check_update"));
  return {
    ...host,
    button,
    click() {
      const target = button();
      if (!target) throw new Error("Missing update button");
      emitHostEvent(target, "onClick");
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  ready.value = true;
  busy.value = false;
  state.value = { phase: "available" };
  current.value = session;
  check.mockReset();
  check.mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    $message: message,
    get electron() {
      throw new Error("Electron bridge accessed");
    },
  });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("opens the available update from the original about-page button and reports no-update", async () => {
  const host = mount();
  await flushSfcHost();
  host.click();
  await flushSfcHost();
  expect(check).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledExactlyOnceWith(current.value);
  expect(host.all().filter((node) => node.tag === "NButton")).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(300);
  state.value = { phase: "no-update" };
  host.click();
  await flushSfcHost();
  expect(message.success).toHaveBeenCalledWith("message.already_latest_version");
  expect(open).toHaveBeenCalledTimes(1);
});
it("ignores a late check when the page closes or its native owner changes", async () => {
  let finish!: () => void;
  check.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const host = mount();
  await flushSfcHost();
  host.click();
  host.close();
  current.value = undefined;
  finish();
  await flushSfcHost();
  expect(open).not.toHaveBeenCalled();
  expect(message.error).not.toHaveBeenCalled();
});
