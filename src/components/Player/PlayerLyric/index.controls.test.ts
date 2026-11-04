import { afterEach, expect, it, vi } from "vitest";
import { reactive, ref } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

it("shows bottom lyric options and a working play control only at phone/tablet widths", async () => {
  const compact = ref(true);
  const time = ref(0);
  const status = reactive({ playStatus: true, playLoading: false, getSongOffset: () => 0 });
  const player = { playOrPause: vi.fn(() => (status.playStatus = !status.playStatus)) };
  const host = mountProductionSfc(
    new URL("./index.vue", import.meta.url),
    {
      "@/stores": {
        useMusicStore: () => ({ playSong: { id: 1, platform: "test" } }),
        useSettingStore: () => ({ lyricRenderer: "amll" }),
        useStatusStore: () => status,
      },
      "@/utils/player": { usePlayer: () => player },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./LyricToolbar.vue": { default: { render: () => null } },
      "@/utils/audioManager": { default: { on: vi.fn(), off: vi.fn() } },
      "@/components/LyricStage/useLyricPlaybackClock": { useLyricPlaybackClock: () => time },
      "@vueuse/core": {
        useMediaQuery: () => compact,
        useDocumentVisibility: () => ref("visible"),
      },
    },
    ["AMLyric", "DefaultLyric", "NPopover", "NButton", "SvgIcon"],
    'import { computed, ref, watch, defineAsyncComponent } from "vue"; import { useMediaQuery, useDocumentVisibility } from "@vueuse/core";',
  );
  cleanups.push(host.close);
  const findPlay = () => host.all().find((node) => node.props.class === "lyric-play-button");
  const stage = host.all().find((node) => node.props.class === "lyric-stage");
  expect(host.all().some((node) => node.props.class === "mobile-lyric-controls")).toBe(true);
  expect(findPlay()?.props["aria-label"]).toBe("common.pause");
  const playButton = findPlay();
  if (!playButton) throw new Error("Missing mobile play control");
  emitHostEvent(playButton, "onClick", { stopPropagation: vi.fn() });
  await flushSfcHost();
  expect(status.playStatus).toBe(false);
  expect(findPlay()?.props["aria-label"]).toBe("common.play");
  expect(player.playOrPause).toHaveBeenCalledOnce();
  expect(host.all().find((node) => node.props.class === "lyric-stage")).toBe(stage);

  compact.value = false;
  await flushSfcHost();
  expect(findPlay()).toBeUndefined();
  expect(host.all().some((node) => node.props.class === "mobile-lyric-controls")).toBe(false);
  expect(host.all().find((node) => node.props.class === "lyric-stage")).toBe(stage);
});
