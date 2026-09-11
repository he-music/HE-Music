<template>
  <div :class="['monet-player-lyric', { pure: statusStore.pureLyricMode }]" :style="fontStyle">
    <MonetLyricRail
      :key="`${musicStore.playSong.platform}-${musicStore.playSong.id}`"
      :lines="lines"
      :clock="clock"
      :playing="statusStore.playStatus"
      :word-animation="settingStore.showYrcAnimation"
      :long-word-effect="settingStore.showYrcLongEffect"
      :loading="statusStore.lyricLoading"
      :font-size="settingStore.lyricFontSize"
      :translation-size="settingStore.lyricTranFontSize"
      :romanization-size="settingStore.lyricRomaFontSize"
      :align-position="settingStore.monetScrollOffset"
      :text-align="textAlign"
      :color="color"
      :show-translation="settingStore.showTran"
      :show-romanization="settingStore.showRoma"
      :blur="settingStore.lyricsBlur"
      :hover-pause="settingStore.lrcMousePause"
      :empty-text="
        t(statusStore.lyricLoading ? 'setting.lyrics.monet_loading' : 'setting.lyrics.monet_empty')
      "
      :seek-label="t('setting.lyrics.monet_seek')"
      @seek="seek"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { lyricFontStyle, lyricLangFontStyle } from "@/utils/lyric/lyricFontConfig";
import { adaptMonetLines, lyricSeekTime } from "@/components/Monet/model";
import MonetLyricRail from "@/components/Monet/MonetLyricRail.vue";

// src/components/Player/PlayerLyric/MonetLyric.vue — 连接现有播放器，轨道本身不依赖 Pinia。
defineProps<{ clock: { time: Readonly<Ref<number>> } }>();
const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();
const lines = computed(() => {
  const lyrics = musicStore.songLyric;
  const wordTimed = Boolean(settingStore.showYrc && lyrics.yrcData?.length);
  return adaptMonetLines(
    wordTimed ? lyrics.yrcData : lyrics.lrcData?.length ? lyrics.lrcData : lyrics.yrcData || [],
    wordTimed,
    statusStore.duration,
  );
});
const color = computed(() => {
  const main = statusStore.songCoverTheme?.main;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "239, 239, 239";
});
const textAlign = computed(() =>
  statusStore.pureLyricMode || settingStore.lyricsPosition === "center"
    ? "center"
    : settingStore.lyricsPosition === "flex-end"
      ? "right"
      : "left",
);
const fontStyle = computed(() => ({
  ...lyricFontStyle(settingStore.lyricFont),
  ...lyricLangFontStyle(settingStore),
}));
function seek(time: number) {
  player.setSeek(lyricSeekTime(time, statusStore.getSongOffset(musicStore.playSong)));
  player.play();
}
</script>

<style scoped lang="scss">
.monet-player-lyric {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding-right: 64px;
  box-sizing: border-box;
  font-weight: 600;
  &.pure {
    padding: 0 64px;
  }
  @media (max-width: 990px) {
    &,
    &.pure {
      padding: 0;
    }
  }
}
</style>
