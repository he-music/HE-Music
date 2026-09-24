<template>
  <div
    :class="[
      'player-lyric',
      {
        monet: settingStore.lyricRenderer === 'monet',
        partita: settingStore.lyricRenderer === 'partita',
        kinetic: settingStore.lyricRenderer === 'kinetic',
        classic: settingStore.lyricRenderer === 'classic',
      },
    ]"
  >
    <!-- 歌词内容 -->
    <AMLyric v-if="settingStore.lyricRenderer === 'amll'" :currentTime="playSeek" />
    <MonetLyric v-else-if="settingStore.lyricRenderer === 'monet'" :clock="lyricClock" />
    <PartitaLyric v-else-if="settingStore.lyricRenderer === 'partita'" :clock="lyricClock" />
    <ClassicLyric v-else-if="settingStore.lyricRenderer === 'classic'" :clock="lyricClock" />
    <KineticLyric v-else-if="settingStore.lyricRenderer === 'kinetic'" :clock="lyricClock" />
    <DefaultLyric v-else :currentTime="playSeek" />
    <!-- 歌词菜单 -->
    <n-flex :class="['lyric-menu', { show: statusStore.playerMetaShow }]" justify="center" vertical>
      <div class="menu-icon" @click="openCopyLyrics">
        <SvgIcon name="Copy" />
      </div>
      <div class="divider" />
      <div class="menu-icon" @click="changeOffset(-500)">
        <SvgIcon name="Replay5" />
      </div>
      <n-popover class="player" trigger="click" placement="left" style="padding: 8px">
        <template #trigger>
          <span class="time">
            {{ currentTimeOffsetValue }}
          </span>
        </template>
        <n-flex class="offset-menu" :size="4" vertical>
          <span class="title"> 歌词偏移 </span>
          <span class="tip"> 正值为歌词提前，单位毫秒 </span>
          <n-input-number
            v-model:value="offsetMilliseconds"
            class="offset-input"
            :precision="0"
            :step="100"
            placeholder="0"
            size="small"
          >
            <template #suffix>ms</template>
          </n-input-number>
          <n-button
            :disabled="offsetMilliseconds == 0"
            class="player"
            size="small"
            secondary
            strong
            @click="resetOffset"
          >
            清零
          </n-button>
        </n-flex>
      </n-popover>
      <div class="menu-icon" @click="changeOffset(500)">
        <SvgIcon name="Forward5" />
      </div>
      <div class="divider" />
      <div class="menu-icon" @click="openSetting('lyrics')">
        <SvgIcon name="Settings" />
      </div>
      <n-popover
        v-model:show="styleMenuShow"
        raw
        :show-arrow="false"
        trigger="click"
        placement="left-end"
        style="border-radius: 8px"
      >
        <template #trigger>
          <button
            type="button"
            class="menu-icon style-button"
            :aria-label="t('setting.play.style')"
            :title="t('setting.play.style')"
            aria-haspopup="dialog"
            :aria-expanded="styleMenuShow"
            @click.stop
          >
            <SvgIcon name="Palette" />
          </button>
        </template>
        <PlayerStylePanel />
      </n-popover>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { openSetting, openCopyLyrics } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
import PlayerStylePanel from "../PlayerStylePanel.vue";
import audioManager from "@/utils/audioManager";
import { useLyricPlaybackClock } from "@/components/LyricStage/useLyricPlaybackClock";

const MonetLyric = defineAsyncComponent(() => import("./MonetLyric.vue"));
const PartitaLyric = defineAsyncComponent(() => import("./PartitaLyric.vue"));
const KineticLyric = defineAsyncComponent(() => import("./KineticLyric.vue"));
const ClassicLyric = defineAsyncComponent(() => import("./ClassicLyric.vue"));

const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();
const styleMenuShow = ref(false);

/**
 * 当前歌曲 id
 */
const currentSong = computed(() => musicStore.playSong);

const documentVisibility = useDocumentVisibility();
const playSeek = useLyricPlaybackClock({
  playing: () => statusStore.playStatus,
  visible: () => documentVisibility.value === "visible",
  identity: () => `${currentSong.value.platform}-${currentSong.value.id}`,
  offset: () => statusStore.getSongOffset(currentSong.value),
  readTime: () => player.getSeek(),
  subscribeSeek: (sample) => {
    audioManager.on("seeked", sample);
    audioManager.on("loadedmetadata", sample);
    return () => {
      audioManager.off("seeked", sample);
      audioManager.off("loadedmetadata", sample);
    };
  },
});
const lyricClock = { time: playSeek };

/**
 * 当前进度偏移值
 */
const currentTimeOffsetValue = computed(() => {
  const currentTimeOffset = statusStore.getSongOffset(currentSong.value);
  if (currentTimeOffset === 0) return "0";
  // 将毫秒转换为秒显示
  const offsetSeconds = parseFloat((currentTimeOffset / 1000).toFixed(2));
  return currentTimeOffset > 0 ? `+${offsetSeconds}` : `${offsetSeconds}`;
});

/**
 * 当前进度偏移值（毫秒）
 */
const offsetMilliseconds = computed({
  get: () => {
    return statusStore.getSongOffset(currentSong.value);
  },
  set: (val: number | null) => {
    statusStore.setSongOffset(currentSong.value, val || 0);
  },
});

/**
 * 改变进度偏移
 * @param delta 偏移量（单位：毫秒）
 */
const changeOffset = (delta: number) => {
  statusStore.incSongOffset(currentSong.value, delta);
};

/**
 * 重置进度偏移
 */
const resetOffset = () => {
  statusStore.resetSongOffset(currentSong.value);
};
</script>

<style lang="scss" scoped>
.player-lyric {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  filter: drop-shadow(0px 4px 6px rgba(0, 0, 0, 0.2));
  mask: linear-gradient(
    180deg,
    hsla(0, 0%, 100%, 0) 0,
    hsla(0, 0%, 100%, 0.6) 5%,
    #fff 10%,
    #fff 75%,
    hsla(0, 0%, 100%, 0.6) 85%,
    hsla(0, 0%, 100%, 0)
  );
  &.monet,
  &.partita,
  &.kinetic,
  &.classic {
    mask: none;
    filter: none;
  }
  @media (hover: hover) and (pointer: fine) {
    &:hover {
      .lyric-menu {
        pointer-events: auto;
        &.show {
          opacity: 0.6;
        }
      }
    }
  }
}
.lyric-menu {
  position: absolute;
  pointer-events: none;
  top: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  width: 80px;
  padding: 20% 0;
  opacity: 0;
  transition: opacity 0.3s;
  .divider {
    height: 2px;
    width: 40px;
    background-color: rgba(var(--main-cover-color), 0.12);
  }
  .time {
    width: 40px;
    margin: 8px 0;
    padding: 4px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    background-color: rgba(var(--main-cover-color), 0.14);
    backdrop-filter: blur(10px);
    border-radius: 8px;
    border: 1px solid rgba(var(--main-cover-color), 0.12);
    transition: background-color 0.3s;
    cursor: pointer;
    &::after {
      content: "s";
      margin-left: 2px;
    }
    &:hover {
      background-color: rgba(var(--main-cover-color), 0.28);
    }
  }
  .style-button {
    width: 42px;
    height: 42px;
    border: 0;
    background: transparent;
    color: rgb(var(--main-cover-color));
    flex-shrink: 0;
    &:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
  }
  &:focus-within {
    pointer-events: auto;
    &.show {
      opacity: 1;
    }
  }
  .menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    border-radius: 8px;
    transition:
      background-color 0.3s,
      transform 0.3s;
    cursor: pointer;
    .n-icon {
      font-size: 30px;
      color: rgb(var(--main-cover-color));
    }
    &:hover {
      transform: scale(1.1);
      background-color: rgba(var(--main-cover-color), 0.14);
    }
    &:active {
      transform: scale(1);
    }
  }
}
.offset-menu {
  width: 180px;
  .title {
    font-size: 14px;
    line-height: normal;
  }
  .tip {
    font-size: 12px;
    opacity: 0.6;
  }
  :deep(.n-input) {
    --n-caret-color: rgb(var(--main-cover-color));
    --n-color: rgba(var(--main-cover-color), 0.1);
    --n-color-focus: rgba(var(--main-cover-color), 0.1);
    --n-text-color: rgb(var(--main-cover-color));
    --n-border-hover: 1px solid rgba(var(--main-cover-color), 0.28);
    --n-border-focus: 1px solid rgba(var(--main-cover-color), 0.28);
    --n-suffix-text-color: rgb(var(--main-cover-color));
    --n-box-shadow-focus: 0 0 8px 0 rgba(var(--main-cover-color), 0.3);
    // 文本选中颜色
    input {
      &::selection {
        background-color: rgba(var(--main-cover-color));
      }
    }
    .n-button {
      --n-text-color: rgb(var(--main-cover-color));
    }
  }
}
</style>
