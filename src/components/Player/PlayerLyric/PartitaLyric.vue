<template>
  <div :class="['partita-player-lyric', { pure: statusStore.pureLyricMode }]" :style="fontStyle">
    <PartitaLyricRail
      :key="`${musicStore.playSong.platform}-${musicStore.playSong.id}`"
      :lines="lines"
      :clock="clock"
      :playing="statusStore.playStatus"
      :word-animation="settingStore.showYrcAnimation"
      :font-size="settingStore.lyricFontSize"
      :translation-size="settingStore.lyricTranFontSize"
      :romanization-size="settingStore.lyricRomaFontSize"
      :show-translation="settingStore.showTran"
      :show-romanization="settingStore.showRoma"
      :show-guide-lines="settingStore.showPartitaGuideLines"
      :show-upcoming="settingStore.showPartitaUpcoming"
      :stagger-min="settingStore.partitaStagger * 0.6"
      :stagger-max="settingStore.partitaStagger * 1.4"
      :color="color"
      :pure="statusStore.pureLyricMode"
      :empty-text="
        t(statusStore.lyricLoading ? 'setting.lyrics.monet_loading' : 'setting.lyrics.monet_empty')
      "
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
import { adaptPartitaLines, lyricSeekTime } from "@/components/Partita/model";
import PartitaLyricRail from "@/components/Partita/PartitaLyricRail.vue";

// src/components/Player/PlayerLyric/PartitaLyric.vue — 连接播放器，展示云阶阶梯歌词
defineProps<{ clock: { time: Readonly<Ref<number>> } }>();

const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();

const lines = computed(() => {
  const lyrics = musicStore.songLyric;
  const wordTimed = Boolean(settingStore.showYrc && lyrics.yrcData?.length);
  return adaptPartitaLines(
    wordTimed ? lyrics.yrcData : lyrics.lrcData?.length ? lyrics.lrcData : lyrics.yrcData || [],
    wordTimed,
    statusStore.duration,
  );
});

const color = computed(() => {
  const main = statusStore.songCoverTheme?.main;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "255, 255, 255";
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

<style scoped lang="scss">
.partita-player-lyric {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding-right: 48px;
  box-sizing: border-box;

  &.pure {
    padding: 0 48px;
  }

  @media (max-width: 990px) {
    &,
    &.pure {
      padding: 0;
    }
  }
}
</style>
