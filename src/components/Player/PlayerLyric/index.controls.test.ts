import { afterEach, expect, it, vi } from "vitest";
import { h, ref } from "vue";
import { flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import { isPVLyricRenderer } from "@/utils/lyric/renderer";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

it.each(["amll", "52hz"])(
  "keeps %s mounted when switching between mobile controls and desktop layout",
  async (renderer) => {
    const compact = ref(true);
    const time = ref(0);
    const status = { playStatus: true, pureLyricMode: true, getSongOffset: () => 0 };
    const host = mountProductionSfc(
      new URL("./index.vue", import.meta.url),
      {
        "@/composables/useOverlayBack": { useOverlayBack: vi.fn() },
        "@/composables/useMobile": {
          useMobile: () => ({ isMobilePlayer: compact }),
        },
        "@/stores": {
          useMusicStore: () => ({ playSong: { id: 1, platform: "test" } }),
          useSettingStore: () => ({ lyricRenderer: renderer }),
          useStatusStore: () => status,
        },
        "@/utils/player": { usePlayer: () => ({}) },
        "@/utils/lyric/renderer": { isPVLyricRenderer },
        "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
        "./AMLyric.vue": { __esModule: true, default: { render: () => h("am-lyric") } },
        "./PVLyric.vue": { __esModule: true, default: { render: () => h("pv-lyric") } },
        "./LyricToolbar.vue": { default: { render: () => null } },
        "./LyricEmptyActions.vue": { default: { render: () => null } },
        "@/composables/useManualLyricActions": {
          useManualLyricActions: () => ({ canSearch: false, hasManual: false }),
        },
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
    await flushSfcHost();
    const pv = host.all().find((node) => node.tag === "pv-lyric");
    if (renderer === "52hz") {
      expect(pv?.props.mode).toBe("52hz");
      expect(pv?.props["full-bleed"]).toBe(false);
    }
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
    if (renderer === "52hz") {
      expect(host.all().find((node) => node.tag === "pv-lyric")).toBe(pv);
      expect(pv?.props["full-bleed"]).toBe(true);
    }
  },
);
