<template>
  <!-- 全屏封面 -->
  <div
    v-if="settingStore.playerType === 'fullscreen' && !isTablet"
    class="full-screen"
    :style="{ '--gradient-percent': '15%' }"
  >
    <s-image
      :src="musicStore.getSongCover(-1)"
      :alt="musicStore.playSong.name"
      :title="musicStore.playSong.name"
      :lazy="false"
      :width="'100%'"
      :height="'100%'"
    />
  </div>
  <!-- 普通封面 -->
  <div
    v-else
    :class="['player-cover', settingStore.playerType, { playing: statusStore.playStatus }]"
  >
    <img
      v-if="settingStore.playerType === 'record'"
      class="pointer"
      src="/images/pointer.png?asset"
      alt="pointer"
    />
    <!-- 专辑图片 -->
    <s-image
      :key="musicStore.getSongCover(-1)"
      :src="musicStore.getSongCover(-1)"
      :observe-visibility="false"
      class="cover-img"
    />
  </div>
</template>

<script setup lang="ts">
import { useMobile } from "@/composables/useMobile";
import { useSettingStore, useStatusStore, useMusicStore } from "@/stores";

const musicStore = useMusicStore();
const statusStore = useStatusStore();
const settingStore = useSettingStore();
const { isTablet } = useMobile();
</script>

<style lang="scss" scoped>
.player-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 70%;
  max-width: 50vh;
  height: auto;
  aspect-ratio: 1 / 1;
  transition:
    transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1),
    width 0.3s;
  .cover-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 1;
    box-shadow: 0 0 20px 10px rgba(0, 0, 0, 0.1);
    transition: opacity 0.1s ease-in-out;
  }
  .dynamic-cover {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    border-radius: 32px;
    overflow: hidden;
    z-index: 1;
    opacity: 0;
    transition: opacity 0.8s ease-in-out;
    backface-visibility: hidden;
    transform: translateZ(0);
    &.loaded {
      opacity: 1;
    }
  }
  &.record {
    position: relative;
    width: 50vh;
    .pointer {
      position: absolute;
      width: 14vh;
      left: calc(50% - 1.8vh);
      top: -11.5vh;
      transform: rotate(-20deg);
      transform-origin: 1.8vh 1.8vh;
      z-index: 2;
      transition: transform 0.3s;
    }
    .cover-img {
      animation: playerCoverRotate 30s linear infinite;
      animation-play-state: paused;
      border-radius: 50%;
      border: 1vh solid #ffffff30;
      background:
        linear-gradient(black 0%, transparent, black 98%),
        radial-gradient(
          #000 52%,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555,
          #000,
          #555
        );
      background-clip: content-box;
      width: 46vh;
      height: 46vh;
      min-width: 46vh;
      display: flex;
      justify-content: center;
      align-items: center;
      :deep(img) {
        border: 1vh solid #ffffff40;
        border-radius: 50%;
        width: 70%;
        height: 70%;
        object-fit: cover;
      }
      .cover-loading {
        position: absolute;
        height: 100%;
        padding-bottom: 0;
        .loading-img {
          top: auto;
          left: auto;
        }
      }
    }
  }
  &.cover {
    border-radius: 32px;
    overflow: hidden;
    transform: scale(0.9);
    &.playing {
      transform: scale(1);
    }
  }
  &.playing {
    .pointer {
      transform: rotate(0);
    }
    .cover-img {
      animation-play-state: running;
    }
  }
}
.full-screen {
  position: fixed;
  left: 0;
  top: 0;
  height: 100vh;
  width: 60vw;
  z-index: 0;
  mask-image: linear-gradient(to right, #000 var(--gradient-percent), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, #000 var(--gradient-percent), transparent 100%);
  :deep(img) {
    object-fit: cover;
    width: 100%;
    height: 100%;
  }
}
</style>
