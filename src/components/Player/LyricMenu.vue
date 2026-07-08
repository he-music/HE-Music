<template>
  <n-flex :class="['menu', { show: statusStore.playerMetaShow }]" justify="center" vertical>
    <div class="menu-icon" @click="openCopyLyrics">
      <SvgIcon name="Copy" />
    </div>
    <div class="menu-icon" @click="changeOffset(-500)">
      <SvgIcon name="Replay5" />
    </div>
    <span class="time" @click="resetOffset()">
      {{ currentTimeOffsetValue }}
    </span>
    <div class="menu-icon" @click="changeOffset(+500)">
      <SvgIcon name="Forward5" />
    </div>
    <div class="divider" />
    <div class="menu-icon" @click="openLyricSetting">
      <SvgIcon name="Settings" />
    </div>
  </n-flex>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import { openSetting, openCopyLyrics } from "@/utils/modal";
import router from "@/router";
import { useMobile } from "@/composables/useMobile";

const musicStore = useMusicStore();
const statusStore = useStatusStore();
const { isSmallScreen } = useMobile();

/**
 * 当前进度偏移值
 */
const currentTimeOffsetValue = computed(() => {
  const currentTimeOffset = statusStore.getSongOffset(musicStore.playSong);
  // 将毫秒转换为秒显示（保留1位小数）
  const offsetSeconds = (currentTimeOffset / 1000).toFixed(1);
  return currentTimeOffset > 0 ? `+${offsetSeconds}` : offsetSeconds;
});

const openLyricSetting = () => {
  if (isSmallScreen.value) {
    statusStore.showFullPlayer = false;
    router.push({
      path: "/setting",
      query: {
        type: "lyrics",
      },
    });
    return;
  }
  openSetting("lyrics");
};

/**
 * 改变进度偏移
 * @param delta 偏移量（单位：毫秒）
 */
const changeOffset = (delta: number) => {
  statusStore.incSongOffset(musicStore.playSong, delta);
};

/**
 * 重置进度偏移
 */
const resetOffset = () => {
  statusStore.resetSongOffset(musicStore.playSong);
};
</script>

<style lang="scss" scoped>
.menu {
  position: absolute;
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

.lyric,
.lyric-am {
  &:hover {
    .menu {
      &.show {
        opacity: 0.6;
      }
    }
  }
}
</style>
