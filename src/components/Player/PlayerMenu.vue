<template>
  <div class="player-menu">
    <Transition name="fade" mode="out-in">
      <div v-show="statusStore.playerMetaShow" class="menu-content">
        <n-flex class="left">
          <div
            v-if="musicStore.isHasLrc"
            :class="['menu-icon', { open: statusStore.pureLyricMode }]"
            @click="setPureLyricMode"
          >
            <SvgIcon name="TextPlay" />
          </div>
        </n-flex>
        <div class="drag-dom" />
        <n-flex class="right" justify="end">
          <button
            v-if="fullscreen"
            class="menu-icon fullscreen-button"
            type="button"
            :aria-label="fullscreenLabel"
            :title="fullscreenLabel"
            @click="toggleFullscreen"
          >
            <SvgIcon :name="isFullscreen ? 'FullscreenExit' : 'Fullscreen'" />
          </button>
          <div v-if="!isFullscreen" class="menu-icon" @click="statusStore.showFullPlayer = false">
            <SvgIcon name="Down" />
          </div>
        </n-flex>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { platform } from "@/platform";
import { useMusicStore, useStatusStore } from "@/stores";
const musicStore = useMusicStore();
const statusStore = useStatusStore();

const { t } = useI18n();
const fullscreen = platform.fullscreen;
const isFullscreen = ref(false);
const fullscreenLabel = computed(() =>
  t(isFullscreen.value ? "common.exit_fullscreen" : "common.enter_fullscreen"),
);

if (fullscreen) {
  let useInitialState = true;
  const stop = fullscreen.onChange((value) => {
    useInitialState = false;
    isFullscreen.value = value;
  });
  Promise.resolve(fullscreen.current())
    .then((value) => {
      if (useInitialState) isFullscreen.value = value;
    })
    .catch(console.error);
  onScopeDispose(() => {
    useInitialState = false;
    stop();
  });
}

const toggleFullscreen = async () => {
  try {
    await fullscreen?.toggle();
  } catch (error) {
    console.error(error);
    window.$message?.error(t("common.fullscreen_failed"));
  }
};

const setPureLyricMode = () => {
  statusStore.pureLyricMode = !statusStore.pureLyricMode;
  statusStore.showPlayerComment = false;
};
</script>

<style lang="scss" scoped>
.player-menu {
  position: absolute;
  top: 0;
  width: 100%;
  min-height: 80px;
  overflow: hidden;
  z-index: 100;
  cursor: pointer;
  .menu-content {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    height: 100%;
  }
  .drag-dom {
    height: 80px;
    margin: 0 100px;
    flex: 1;
    -webkit-app-region: drag;
  }
  .left,
  .right {
    padding: 0 20px;
    transition: opacity 0.3s;
    .menu-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 8px;
      transition:
        opacity 0.3s,
        background-color 0.3s,
        transform 0.3s;
      cursor: pointer;
      .n-icon {
        font-size: 28px;
        color: rgb(var(--main-cover-color));
      }
      &:hover {
        transform: scale(1.05);
        background-color: rgba(var(--main-cover-color), 0.14);
        opacity: 1;
      }
      &:active {
        transform: scale(1);
      }
    }
  }
  .fullscreen-button {
    padding: 0;
    border: 0;
    background: transparent;
    -webkit-app-region: no-drag;
  }
  .left {
    .menu-icon {
      opacity: 0.6;
      &.open {
        opacity: 1;
        &:hover {
          opacity: 1;
        }
      }
      &:hover {
        opacity: 0.6;
      }
    }
  }
}
</style>
