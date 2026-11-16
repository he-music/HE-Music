import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import { debounce } from "lodash-es";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import type { UpdatesState } from "@/platform/updates";

const state = shallowRef<UpdatesState>();
const check = vi.fn(async () => {});
const message = { error: vi.fn() };
const cleanups: Array<() => void> = [];
function mount() {
  const host = mountProductionSfc(
    new URL("./AboutSetting.vue", import.meta.url),
    {
      "@/utils/helper": { openLink: vi.fn() },
      "@/utils/modal": { openUserAgreement: vi.fn() },
      "@/utils/updateLog": { getUpdateLog: async () => [] },
      "lodash-es": { debounce },
      "@/stores": { useStatusStore: () => ({ updateCheck: false }) },
      "github-markdown-css/github-markdown.css": {},
      "@/../package.json": { default: { version: "1.0.4", github: "https://github.test/music" } },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/platform": { platform: { kind: "mygo", updates: { check } } },
      "@/platform/updates": { updatesState: state },
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
      .find(
        (node) =>
          node.tag === "NButton" &&
          ["setting.about.check_update", "updates.view"].includes(text(node)),
      );
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
  state.value = undefined;
  check.mockReset();
  check.mockResolvedValue(undefined);
  message.error.mockReset();
  vi.stubGlobal("window", { $message: message });
});
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("delegates checking and all result dialogs to the official updater", async () => {
  const host = mount();
  await flushSfcHost();
  host.click();
  await flushSfcHost();
  expect(check).toHaveBeenCalledOnce();
  expect(host.button()?.props.loading).toBe(false);
  expect(host.all().filter((node) => node.tag === "NButton")).toHaveLength(3);
  state.value = { revision: 1, availableVersion: "2.0.4", installed: true };
  await flushSfcHost();
  await vi.advanceTimersByTimeAsync(300);
  host.click();
  await flushSfcHost();
  expect(check).toHaveBeenCalledTimes(2);
});

it("reports delivery errors only while the settings page is mounted", async () => {
  let reject!: (error: Error) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const host = mount();
  await flushSfcHost();
  host.click();
  host.close();
  reject(new Error("page ended"));
  await flushSfcHost();
  expect(message.error).not.toHaveBeenCalled();
});
