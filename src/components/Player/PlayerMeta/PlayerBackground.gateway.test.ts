import { afterEach, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, reactive } from "vue";
import * as Vue from "vue";
import { flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import { gatewayProxyUrl } from "@/platform/gateway";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

it.each([false, true])("流体背景在 mygo=%s 时仅派生 album 消费地址，切歌仍更新", async (mygo) => {
  vi.stubGlobal(
    "window",
    mygo ? { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123/session" } : {},
  );
  const music = reactive({ songCover: "https://images.invalid/one.jpg", isHasLrc: true });
  const settings = reactive({ playerBackgroundType: "animation" });
  const transition = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("transition-host", slots.default?.()),
  });
  const host = mountProductionSfc(
    new URL("./PlayerBackground.vue", import.meta.url),
    {
      vue: { ...Vue, Transition: transition },
      "@/stores": { useMusicStore: () => music, useSettingStore: () => settings },
      "@/platform/gateway": { gatewayProxyUrl },
      "@/components/AMLL/BackgroundRender.vue": {
        __esModule: true,
        default: defineComponent({
          inheritAttrs: false,
          setup:
            (_, { attrs }) =>
            () =>
              h("BackgroundRender", attrs),
        }),
      },
    },
    ["s-image", "ArtistPhotoBackground"],
  );
  cleanups.push(host.close);
  await flushSfcHost();
  expect(host.all().find((node) => node.tag === "BackgroundRender")?.props.album).toBe(
    gatewayProxyUrl(music.songCover),
  );
  music.songCover = "https://images.invalid/two.jpg";
  await nextTick();
  expect(host.all().find((node) => node.tag === "BackgroundRender")?.props.album).toBe(
    gatewayProxyUrl(music.songCover),
  );
  expect(music.songCover).toBe("https://images.invalid/two.jpg");
});
