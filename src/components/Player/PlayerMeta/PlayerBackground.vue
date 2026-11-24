<template>
  <div :class="['background', backgroundType]">
    <Transition name="fade" mode="out-in">
      <!-- 背景色 -->
      <div v-if="backgroundType === 'color'" :key="musicStore.songCover" class="color" />
      <!-- 背景模糊 -->
      <s-image
        v-else-if="backgroundType === 'blur'"
        :src="musicStore.songCover"
        :observe-visibility="false"
        class="bg-img"
        alt="cover"
      />
      <!-- 歌手写真 -->
      <ArtistPhotoBackground v-else-if="backgroundType === 'artist-photo'" />
      <!-- 流体效果 -->
      <BackgroundRender
        v-else-if="backgroundType === 'animation'"
        :album="gatewayProxyUrl(musicStore.songCover)"
        :playing="statusStore.playStatus"
        :fps="settingStore.playerBackgroundFps ?? 60"
        :flowSpeed="settingStore.playerBackgroundFlowSpeed ?? 4"
        :hasLyric="musicStore.isHasLrc"
        :renderScale="0.5"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { gatewayProxyUrl } from "@/platform/gateway";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";

const BackgroundRender = defineAsyncComponent(
  () => import("@/components/AMLL/BackgroundRender.vue"),
);
const musicStore = useMusicStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();

const backgroundType = computed(() => {
  const type = settingStore.playerBackgroundType;
  if (type !== "artist-photo") return type;

  const platform = musicStore.playSong.platform;
  return musicStore.isLocalSong || !platform || platform === "local" ? "blur" : type;
});
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
