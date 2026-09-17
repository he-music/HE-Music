<template>
  <div :class="['classic-player-lyric', { pure: statusStore.pureLyricMode }]" :style="fontStyle">
    <ClassicLyricRail
      :key="`${musicStore.playSong.platform}-${musicStore.playSong.id}`"
      :lines="lines"
      :clock="clock"
      :playing="statusStore.playStatus"
      :loading="statusStore.lyricLoading"
      :font-size="settingStore.lyricFontSize"
      :translation-size="settingStore.lyricTranFontSize"
      :romanization-size="settingStore.lyricRomaFontSize"
      :show-translation="settingStore.showTran"
      :show-romanization="settingStore.showRoma"
      :word-animation="settingStore.showYrcAnimation"
      :show-upcoming="settingStore.classicShowUpcoming"
      :enable-word-rotation="settingStore.classicWordRotation"
      :breathing-float-multiplier="settingStore.classicBreathingFloat"
      :word-spacing="settingStore.classicWordSpacing"
      :main-color="mainColor"
      :accent-color="mainColor"
      :empty-text="
        t(
          statusStore.lyricLoading
            ? 'setting.lyrics.classic_loading'
            : 'setting.lyrics.classic_empty',
        )
      "
      :seek-label="t('setting.lyrics.classic_seek')"
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
import { adaptClassicLines, lyricSeekTime } from "@/components/Classic/model";
import ClassicLyricRail from "@/components/Classic/ClassicLyricRail.vue";

// src/components/Player/PlayerLyric/ClassicLyric.vue — 连接播放器，展示流光（Classic）歌词
defineProps<{ clock: { time: Readonly<Ref<number>> } }>();

const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();

const lines = computed(() => {
  const lyrics = musicStore.songLyric;
  const wordTimed = Boolean(settingStore.showYrc && lyrics.yrcData?.length);
  return adaptClassicLines(
    wordTimed ? lyrics.yrcData : lyrics.lrcData?.length ? lyrics.lrcData : lyrics.yrcData || [],
    wordTimed,
    statusStore.duration,
  );
});

const mainColor = computed(() => {
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

<style scoped lang="scss">
.classic-player-lyric {
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
