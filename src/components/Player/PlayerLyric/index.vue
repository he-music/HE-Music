<template>
  <div
    :class="[
      'player-lyric',
      {
        compact: compactToolbar,
        monet: settingStore.lyricRenderer === 'monet',
        partita: settingStore.lyricRenderer === 'partita',
        kinetic: settingStore.lyricRenderer === 'kinetic',
        classic: settingStore.lyricRenderer === 'classic',
      },
    ]"
  >
    <!-- 歌词内容 -->
    <div class="lyric-stage">
      <AMLyric v-if="settingStore.lyricRenderer === 'amll'" :clock="lyricClock" />
      <MonetLyric v-else-if="settingStore.lyricRenderer === 'monet'" :clock="lyricClock" />
      <PartitaLyric v-else-if="settingStore.lyricRenderer === 'partita'" :clock="lyricClock" />
      <ClassicLyric v-else-if="settingStore.lyricRenderer === 'classic'" :clock="lyricClock" />
      <KineticLyric v-else-if="settingStore.lyricRenderer === 'kinetic'" :clock="lyricClock" />
      <DefaultLyric v-else :clock="lyricClock" />
    </div>
    <!-- 歌词菜单 -->
    <div v-if="compactToolbar" class="mobile-lyric-controls" @touchstart.stop>
      <n-popover
        raw
        v-model:show="toolbarShow"
        trigger="click"
        placement="top-start"
        :show-arrow="false"
        style="padding: 0; border-radius: 12px"
      >
        <template #trigger>
          <button
            type="button"
            ref="toolbarTrigger"
            class="lyric-tools-button"
            :aria-label="t('lyricToolbar.label')"
            :aria-expanded="toolbarShow"
            aria-haspopup="dialog"
            @click.stop
            @touchstart.stop
            @keydown.esc.stop="closeToolbar"
          >
            <span>{{ t("lyricToolbar.shortLabel") }}</span>
          </button>
        </template>
        <div role="dialog" :aria-label="t('lyricToolbar.label')" @keydown.esc.stop="closeToolbar">
          <LyricToolbar compact />
        </div>
      </n-popover>
      <n-button
        circle
        class="lyric-play-button"
        color="#fff"
        text-color="#24323c"
        style="width: 52px; height: 52px"
        :bordered="false"
        :loading="statusStore.playLoading"
        :aria-label="t(statusStore.playStatus ? 'common.pause' : 'common.play')"
        @click.stop="player.playOrPause()"
      >
        <template #icon>
          <SvgIcon :name="statusStore.playStatus ? 'Pause' : 'Play'" :size="30" />
        </template>
      </n-button>
    </div>
    <LyricToolbar v-else class="lyric-menu" />
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
import LyricToolbar from "./LyricToolbar.vue";
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
const compactToolbar = useMediaQuery("(max-width: 989.98px)");
const toolbarShow = ref(false);
const toolbarTrigger = ref<HTMLButtonElement>();
const closeToolbar = () => {
  toolbarShow.value = false;
  toolbarTrigger.value?.focus();
};

/**
 * 当前歌曲 id
 */
const currentSong = computed(() => musicStore.playSong);

watch([() => currentSong.value.id, () => currentSong.value.platform, compactToolbar], () => {
  toolbarShow.value = false;
});
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
</script>

<style lang="scss" scoped>
.player-lyric {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  .lyric-stage {
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
  }
  &.monet,
  &.partita,
  &.kinetic,
  &.classic {
    .lyric-stage {
      mask: none;
      filter: none;
    }
  }
  @media (hover: hover) and (pointer: fine) {
    &:hover {
      :deep(.lyric-menu) {
        pointer-events: auto;
        &.show {
          opacity: 0.6;
        }
      }
    }
  }
}
.mobile-lyric-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 12px 4px max(16px, env(safe-area-inset-bottom, 0px));
  .lyric-tools-button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    color: rgb(var(--main-cover-color));
    background: transparent;
    cursor: pointer;
    span {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 30px;
      height: 30px;
      padding: 0 6px;
      border: 1.5px solid currentColor;
      border-radius: 11px;
      font-size: 16px;
      line-height: 1;
    }
    &:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
      border-radius: 12px;
    }
  }
}
.player-lyric.compact {
  --lyric-toolbar-space: 0px;
  display: flex;
  flex-direction: column;
  .lyric-stage {
    flex: 1;
    height: auto;
  }
}
</style>
