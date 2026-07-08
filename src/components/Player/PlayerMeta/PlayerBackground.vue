<template>
  <div :class="['background', settingStore.playerBackgroundType]">
    <Transition name="fade" mode="out-in">
      <!-- 背景色 -->
      <div
        v-if="settingStore.playerBackgroundType === 'color'"
        :key="musicStore.songCover"
        class="color"
      />
      <!-- 背景模糊 -->
      <s-image
        v-else-if="settingStore.playerBackgroundType === 'blur'"
        :src="musicStore.songCover"
        :observe-visibility="false"
        class="bg-img"
        alt="cover"
      />
      <!-- 歌手写真 -->
      <ArtistPhotoBackground v-else-if="settingStore.playerBackgroundType === 'artist-photo'" />
      <!-- 流体效果 -->
      <BackgroundRender
        v-else-if="settingStore.playerBackgroundType === 'animation'"
        :album="musicStore.songCover"
        :fps="settingStore.playerBackgroundFps ?? 60"
        :flowSpeed="settingStore.playerBackgroundFlowSpeed ?? 4"
        :hasLyric="musicStore.isHasLrc"
        :renderScale="0.5"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useSettingStore } from "@/stores";

const musicStore = useMusicStore();
const settingStore = useSettingStore();
</script>

<style lang="scss" scoped>
.background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: -1;
  &::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    //backdrop-filter: blur(20px);
  }
  &.blur {
    display: flex;
    align-items: center;
    justify-content: center;
    .bg-img {
      width: 100%;
      height: auto;
      transform: scale(1.5);
      filter: blur(80px) contrast(1.2);
    }
  }
  &.color {
    background-color: rgb(var(--main-cover-color));
    .color {
      width: 100%;
      height: 100%;
      background-color: rgb(var(--main-cover-color));
    }
  }
  &.artist-photo {
    /* reuse logic if needed, but SingerBackground handles its own style */
    ::v-deep(.photo-background) {
      position: absolute;
      width: 100%;
      height: 100%;
    }
  }
  &.animation {
    &::after {
      display: none;
    }
  }
}
</style>
