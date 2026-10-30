import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { mountProductionSfc, flushSfcHost } from "@/test/productionSfc";
import { groupSongs } from "@/utils/songGroup";

it("routes Mygo album covers through local artwork without accessing Electron or mutating songs", async () => {
  vi.stubGlobal("window", {
    get electron() {
      throw new Error("Electron accessed");
    },
  });
  const props = {
    id: "local-one",
    platform: "local",
    path: "song.mp3",
    name: "Song",
    album: "Album",
    artists: "Artist",
    cover: "/images/song.jpg?asset",
    links: [],
    duration: 1,
    mv_id: "",
    subtitle: "",
  };
  const data = Vue.shallowRef([props]);
  const host = mountProductionSfc(
    new URL("./albums.vue", import.meta.url),
    {
      vue: { ...Vue, resolveDirective: () => ({}) },
      "@/utils/env": { isMygo: true },
      "@/components/Local/LocalArtworkImage.vue": {
        default: Vue.defineComponent({
          props: ["song", "alt"],
          setup: (props) => () => Vue.h("native-artwork", { song: props.song, alt: props.alt }),
        }),
      },
      "@/platform/gateway": { gatewayProxyUrl: (url: string) => url },
      "@/utils/songGroup": { groupSongs },
      "@/utils/blob": { default: {} },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    },
    ["NScrollbar", "NCard", "NText", "SvgIcon", "NImage", "SongList"],
    'import { computed, ref, watch } from "vue";',
    { data: data.value },
  );
  await flushSfcHost();
  expect(host.all().find((node) => node.tag === "native-artwork")?.props.song).toEqual(props);
  expect(host.all().some((node) => node.tag === "NImage")).toBe(false);
  host.close();
  expect(data.value[0].cover).toBe("/images/song.jpg?asset");
});
afterEach(() => {
  vi.unstubAllGlobals();
});
