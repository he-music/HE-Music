<template>
  <div :class="['monet-player-lyric', { pure: statusStore.pureLyricMode }]" :style="fontStyle">
    <!-- 1. 背景浮动樱花装饰微粒（移植自 Folia MonetFloatingDecor） -->
    <MonetFloatingDecor :color="color" />

    <!-- 2. 海报左侧艺术头部排版（在全屏纯歌词模式下呈现 Folia 标志性海报布局） -->
    <div v-if="statusStore.pureLyricMode" class="monet-poster-sidebar">
      <div class="poster-artist">{{ artistName }}</div>
      <div class="poster-divider" :style="{ background: `linear-gradient(180deg, rgba(${color}, 0.72), transparent)` }" />
      <div class="poster-title">{{ musicStore.playSong.name || "Monet" }}</div>
      <div class="poster-album">{{ albumName }}</div>
      <div class="poster-capsule">
        <span class="capsule-dot" />
        <span class="capsule-text">MONET</span>
      </div>
    </div>

    <!-- 3. 莫奈歌词滚动轨道 -->
    <div class="monet-rail-container">
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
import MonetFloatingDecor from "@/components/Monet/MonetFloatingDecor.vue";

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
  const main = statusStore.playerMainColor;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "239, 239, 239";
});
const artistName = computed(() => {
  const ar = musicStore.playSong.artists;
  if (!ar) return "Monet";
  if (Array.isArray(ar)) {
    return ar.map((a) => a.name).join(" / ") || "Monet";
  }
  return String(ar);
});
const albumName = computed(() => {
  const al = musicStore.playSong.album;
  if (!al) return "Monet";
  if (typeof al === "object" && al !== null && "name" in al) {
    return al.name || "Monet";
  }
  return String(al);
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
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding-right: 64px;
  box-sizing: border-box;
  font-weight: 600;

  &.pure {
    padding: 0 64px;
    gap: 48px;
  }

  // 莫奈海报侧边艺术排版（移植自 Folia VisualizerMonet）
  .monet-poster-sidebar {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 0 0 clamp(200px, 25vw, 320px);
    max-width: 340px;
    padding: 24px 0;
    user-select: none;
    z-index: 1;

    .poster-artist {
      font-size: clamp(1.1rem, 2vw, 1.8rem);
      font-style: italic;
      color: rgba(var(--monet-color, 239, 239, 239), 0.96);
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-bottom: 12px;
    }

    .poster-divider {
      width: 1px;
      height: 48px;
      border-radius: 999px;
      margin-bottom: 16px;
    }

    .poster-title {
      font-size: clamp(1.5rem, 3.2vw, 2.8rem);
      font-weight: 700;
      line-height: 1.12;
      margin-bottom: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
      color: rgb(var(--monet-color, 239, 239, 239));
    }

    .poster-album {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.72;
      margin-bottom: 24px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .poster-capsule {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(12px);
      width: fit-content;

      .capsule-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #00e676;
      }

      .capsule-text {
        font-size: 11px;
        letter-spacing: 0.08em;
        font-weight: 700;
        opacity: 0.85;
      }
    }
  }

  .monet-rail-container {
    flex: 1;
    min-width: 0;
    height: 100%;
    position: relative;
    z-index: 1;
  }

  @media (max-width: 990px) {
    &,
    &.pure {
      padding: 0;
      flex-direction: column;
    }

    .monet-poster-sidebar {
      display: none; // 窄屏移动端聚焦于歌词轨道
    }
  }
}
</style>
