import { afterEach, expect, it, vi } from "vitest";
import { h, ref } from "vue";
import { flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

it("shows bottom lyric options and the shared play control only at phone/tablet widths", async () => {
  const compact = ref(true);
  const time = ref(0);
  const status = { playStatus: true, getSongOffset: () => 0 };
  const host = mountProductionSfc(
    new URL("./index.vue", import.meta.url),
    {
      "@/stores": {
        useMusicStore: () => ({ playSong: { id: 1, platform: "test" } }),
        useSettingStore: () => ({ lyricRenderer: "amll" }),
        useStatusStore: () => status,
      },
      "@/utils/player": { usePlayer: () => ({}) },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "./LyricToolbar.vue": { default: { render: () => null } },
      "../PlayerStylePanel.vue": { default: { render: () => null } },
      "../PlayerComponents/MobilePlayButton.vue": {
        default: { render: () => h("mobile-play-button") },
      },
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
  expect(findPlay()?.tag).toBe("mobile-play-button");
  expect(findPlay()?.props.compact).toBe("");

  compact.value = false;
  await flushSfcHost();
  expect(findPlay()).toBeUndefined();
  expect(host.all().some((node) => node.props.class === "mobile-lyric-controls")).toBe(false);
  expect(host.all().find((node) => node.props.class === "lyric-stage")).toBe(stage);
});
