<template>
  <div
    :class="['lyric-toolbar', { compact, show: statusStore.playerMetaShow }]"
    role="toolbar"
    :aria-label="t('lyricToolbar.label')"
  >
    <button
      type="button"
      class="menu-icon"
      :aria-label="t('common.copy_lyrics')"
      @click="openCopyLyrics"
    >
      <SvgIcon name="Copy" />
    </button>
    <div class="divider" />
    <button
      type="button"
      class="menu-icon"
      :aria-label="t('lyricToolbar.delay')"
      @click="changeOffset(-500)"
    >
      <SvgIcon name="Replay5" />
    </button>
    <n-popover
      class="player"
      trigger="click"
      :placement="compact ? 'bottom' : 'left'"
      style="padding: 8px"
    >
      <template #trigger>
        <button type="button" class="time" :aria-label="t('lyricToolbar.offset')">
          {{ currentTimeOffsetValue }}
        </button>
      </template>
      <n-flex class="offset-menu" :size="4" vertical>
        <span class="title">{{ t("lyricToolbar.offset") }}</span>
        <span class="tip">{{ t("lyricToolbar.offsetHint") }}</span>
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
          :disabled="offsetMilliseconds === 0"
          class="player"
          size="small"
          secondary
          strong
          @click="resetOffset"
        >
          {{ t("lyricToolbar.reset") }}
        </n-button>
      </n-flex>
    </n-popover>
    <button
      type="button"
      class="menu-icon"
      :aria-label="t('lyricToolbar.advance')"
      @click="changeOffset(500)"
    >
      <SvgIcon name="Forward5" />
    </button>
    <div class="divider" />
    <button
      type="button"
      class="menu-icon"
      :aria-label="t('lyricToolbar.settings')"
      @click="openLyricSetting"
    >
      <SvgIcon name="Settings" />
    </button>
    <button
      v-if="compact"
      type="button"
      class="menu-icon"
      :aria-label="t('setting.play.style')"
      aria-haspopup="dialog"
      @click="emit('style')"
    >
      <SvgIcon name="Palette" />
    </button>
    <n-popover
      v-else
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
          class="menu-icon"
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useMusicStore, useStatusStore } from "@/stores";
import { openSetting, openCopyLyrics } from "@/utils/modal";
import PlayerStylePanel from "../PlayerStylePanel.vue";
import router from "@/router";

const props = defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ close: []; style: [] }>();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
const { t } = useI18n();
const styleMenuShow = ref(false);
const currentSong = computed(() => musicStore.playSong);
const currentTimeOffsetValue = computed(() => {
  const offset = statusStore.getSongOffset(currentSong.value);
  const seconds = parseFloat((offset / 1000).toFixed(2));
  return offset > 0 ? `+${seconds}` : `${seconds}`;
});
const offsetMilliseconds = computed({
  get: () => statusStore.getSongOffset(currentSong.value),
  set: (value: number | null) => statusStore.setSongOffset(currentSong.value, value || 0),
});
const changeOffset = (delta: number) => statusStore.incSongOffset(currentSong.value, delta);
const resetOffset = () => statusStore.resetSongOffset(currentSong.value);
const openLyricSetting = () => {
  emit("close");
  if (props.compact) {
    statusStore.showFullPlayer = false;
    void router.push({ path: "/setting", query: { type: "lyrics" } });
    return;
  }
  void openSetting("lyrics");
};
</script>

<style scoped lang="scss">
.lyric-toolbar {
  position: absolute;
  pointer-events: none;
  top: 50%;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 80px;
  padding: 12px 0;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.3s;

  &:focus-within {
    pointer-events: auto;
    &.show {
      opacity: 1;
    }
  }
  .divider {
    height: 2px;
    width: 40px;
    background-color: rgba(var(--main-cover-color), 0.12);
  }
  button {
    appearance: none;
    color: rgb(var(--main-cover-color));
    font: inherit;
    cursor: pointer;
    &:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
  }
  .menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    padding: 6px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    flex-shrink: 0;
    transition:
      background-color 0.3s,
      transform 0.3s;
    .n-icon {
      font-size: 30px;
    }
    @media (hover: hover) and (pointer: fine) {
      &:hover {
        transform: scale(1.1);
        background-color: rgba(var(--main-cover-color), 0.14);
      }
    }
    &:active {
      transform: scale(1);
    }
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
    &::after {
      content: "s";
      margin-left: 2px;
    }
  }
  @media (hover: none), (any-pointer: coarse) {
    pointer-events: auto;
    opacity: 0.8;
  }
  &.compact {
    position: static;
    transform: none;
    pointer-events: auto;
    flex-direction: row;
    width: auto;
    max-width: calc(100vw - 32px);
    height: auto;
    padding: 4px;
    --main-cover-color: 239, 239, 239;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: rgba(28, 28, 30, 0.96);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    opacity: 1;
    gap: 0;
    .divider {
      display: none;
    }
    .menu-icon,
    .time {
      width: 44px;
      height: 44px;
      margin: 0;
      flex-shrink: 0;
    }
    .menu-icon .n-icon {
      font-size: 24px;
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
    input::selection {
      background-color: rgba(var(--main-cover-color));
    }
  }
}
</style>
