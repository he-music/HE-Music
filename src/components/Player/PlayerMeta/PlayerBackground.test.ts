import { expect, it } from "vitest";
import { BaseTransition, nextTick, reactive } from "vue";
import * as Vue from "vue";
import { mountProductionSfc } from "@/test/productionSfc";
import { gatewayProxyUrl } from "@/platform/gateway";

it.each([
  { platform: "local", path: "album/song.flac" },
  { platform: "local", path: undefined },
  { platform: "", path: undefined },
  { platform: "qq", path: "album/song.flac" },
])("本地歌曲或无平台歌曲不挂载写真背景（%j）", async (song) => {
  const music = reactive({
    playSong: song,
    songCover: "blob:local-cover",
    get isLocalSong() {
      return Boolean(this.playSong.path);
    },
  });
  const settings = reactive({ playerBackgroundType: "none" });
  const host = mountProductionSfc(
    new URL("./PlayerBackground.vue", import.meta.url),
    {
      vue: { ...Vue, Transition: BaseTransition },
      "@/stores": {
        useMusicStore: () => music,
        useSettingStore: () => settings,
        useStatusStore: () => ({}),
      },
      "@/platform/gateway": { gatewayProxyUrl },
    },
    ["s-image", "ArtistPhotoBackground"],
  );
  const assertBlurBackground = () => {
    expect(host.all().some((node) => node.tag === "ArtistPhotoBackground")).toBe(false);
    expect(host.all().find((node) => node.tag === "div")?.props.class).toBe("background blur");
    expect(host.all().find((node) => node.tag === "s-image")?.props.src).toBe(music.songCover);
    expect(settings.playerBackgroundType).toBe("artist-photo");
  };
  try {
    settings.playerBackgroundType = "artist-photo";
    await nextTick();
    assertBlurBackground();

    music.playSong = { platform: "qq", path: undefined };
    await nextTick();
    expect(host.all().some((node) => node.tag === "ArtistPhotoBackground")).toBe(true);

    music.playSong = song;
    await nextTick();
    assertBlurBackground();
  } finally {
    host.close();
  }
});
