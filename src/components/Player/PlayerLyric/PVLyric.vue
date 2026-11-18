<template>
  <LyricPVStage
    :mode="mode"
    :full-bleed="fullBleed"
    :lines="lines"
    :clock="clock"
    :seed="`${song.platform}-${song.id}`"
    :duration="statusStore.duration"
    :playing="statusStore.playStatus"
    :title="song.name"
    :artist="artist"
    :album="album"
    :color="color"
    :word-animation="settingStore.showYrcAnimation"
    :show-translation="settingStore.showTran"
    :show-romanization="settingStore.showRoma"
    :translation-size="settingStore.lyricTranFontSize"
    :romanization-size="settingStore.lyricRomaFontSize"
    :empty-text="
      t(statusStore.lyricLoading ? 'setting.lyrics.monet_loading' : 'setting.lyrics.monet_empty')
    "
    :style="fontStyle"
    @seek="seek"
  />
</template>

<script setup lang="ts">
import { computed, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingStore, useStatusStore } from "@/stores";
import { useMusicStore } from "@/stores/music";
import { usePlayer } from "@/utils/player";
import { lyricFontStyle, lyricLangFontStyle } from "@/utils/lyric/lyricFontConfig";
import { adaptPartitaLines, lyricSeekTime } from "@/components/Partita/model";
import LyricPVStage from "@/components/LyricPV/LyricPVStage.vue";
import type { PVMode } from "@/components/LyricPV/runtime";

// 花火与绘光共用播放器入口，复用已移植效果的歌词归一化、字体和跳转偏移规则。
defineProps<{ mode: PVMode; fullBleed?: boolean; clock: { time: Readonly<Ref<number>> } }>();
const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();
const song = computed(() => musicStore.playSong);
const lines = computed(() => {
  const lyric = musicStore.songLyric;
  const timed = Boolean(settingStore.showYrc && lyric.yrcData?.length);
  return adaptPartitaLines(
    timed ? lyric.yrcData : lyric.lrcData?.length ? lyric.lrcData : lyric.yrcData || [],
    timed,
    statusStore.duration,
  );
});
const artist = computed(() =>
  Array.isArray(song.value.artists)
    ? song.value.artists.map((artist) => artist.name).join(" / ")
    : song.value.artists,
);
const album = computed(() =>
  typeof song.value.album === "string" ? song.value.album : song.value.album.name,
);
const color = computed(() => {
  const main = statusStore.playerMainColor;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "239, 239, 239";
});
const fontStyle = computed(() => ({
  ...lyricFontStyle(settingStore.lyricFont),
  ...lyricLangFontStyle(settingStore),
}));
function seek(time: number) {
  player.setSeek(lyricSeekTime(time, statusStore.getSongOffset(musicStore.playSong)));
  player.play();
}
</script>
