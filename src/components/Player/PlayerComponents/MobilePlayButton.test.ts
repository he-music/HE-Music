import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

it.each([false, true])("shares playback and loading behavior for compact=%s", async (compact) => {
  const status = reactive({ playStatus: true, playLoading: false });
  const playOrPause = vi.fn(() => (status.playStatus = !status.playStatus));
  const host = mountProductionSfc(
    new URL("./MobilePlayButton.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/stores": { useStatusStore: () => status },
      "@/utils/player": { usePlayer: () => ({ playOrPause }) },
    },
    ["NButton", "SvgIcon"],
    "",
    { compact },
  );
  cleanups.push(host.close);
  const button = () => host.all().find((node) => node.tag === "NButton");
  const target = button();
  if (!target) throw new Error("Missing shared mobile play button");
  expect(target.props["aria-label"]).toBe("common.pause");
  emitHostEvent(target, "onClick", { stopPropagation: vi.fn() });
  await flushSfcHost();
  expect(playOrPause).toHaveBeenCalledOnce();
  expect(button()?.props["aria-label"]).toBe("common.play");
  status.playLoading = true;
  await flushSfcHost();
  expect(button()?.props.loading).toBe(true);
});
