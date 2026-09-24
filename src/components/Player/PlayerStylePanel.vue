<template>
  <div class="player-style-panel" role="dialog" :aria-label="t('setting.play.style')">
    <n-tabs default-value="lyrics" type="segment" size="small" :theme-overrides="tabTheme">
      <n-tab-pane v-for="group in groups" :key="group.key" :name="group.key" :tab="group.label">
        <div class="style-options" role="group" :aria-label="group.description">
          <button
            v-for="option in group.options"
            :key="option.value"
            type="button"
            class="style-option"
            :class="{ selected: group.value === option.value }"
            :aria-pressed="group.value === option.value"
            @click="group.select(option.value)"
          >
            <span>{{ option.label }}</span>
            <svg
              class="selection-mark"
              :class="{ visible: group.value === option.value }"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m5 12 4 4L19 6"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { TabsProps } from "naive-ui";
import { useSettingStore } from "@/stores";
import { resolveLyricRenderer } from "@/utils/lyric/renderer";

const settingStore = useSettingStore();
const { t } = useI18n();
const tabTheme: TabsProps["themeOverrides"] = {
  tabTextColorSegment: "rgba(var(--main-cover-color), 0.7)",
  tabTextColorActiveSegment: "rgb(var(--main-cover-color))",
  tabTextColorHoverSegment: "rgb(var(--main-cover-color))",
  tabColorSegment: "rgba(var(--main-cover-color), 0.16)",
  colorSegment: "rgba(var(--main-cover-color), 0.06)",
  panePaddingSmall: "8px 0 0",
};
const groups = computed(() => [
  {
    key: "player",
    label: t("common.player"),
    description: t("setting.play.player_type"),
    value: settingStore.playerType,
    options: ["cover", "record", "fullscreen"].map((value) => ({
      value,
      label: t(`setting.play.player_tip_value_${value}`),
    })),
    select: (value: string) => {
      if (value === "cover" || value === "record" || value === "fullscreen") {
        settingStore.playerType = value;
      }
    },
  },
  {
    key: "background",
    label: t("setting.play.background"),
    description: t("setting.play.player_background_type"),
    value: settingStore.playerBackgroundType,
    options: ["animation", "blur", "color", "artist-photo"].map((value) => ({
      value,
      label: t(`setting.play.player_background_type_value_${value}`),
    })),
    select: (value: string) => {
      if (
        value === "animation" ||
        value === "blur" ||
        value === "color" ||
        value === "artist-photo"
      ) {
        settingStore.playerBackgroundType = value;
      }
    },
  },
  {
    key: "lyrics",
    label: t("common.lyrics"),
    description: t("setting.lyrics.renderer"),
    value: settingStore.lyricRenderer,
    options: ["default", "amll", "monet", "partita", "classic", "kinetic"].map((value) => ({
      value,
      label: value === "amll" ? "AMLL" : t(`setting.lyrics.renderer_${value}`),
    })),
    select: (value: string) => {
      settingStore.lyricRenderer = resolveLyricRenderer(value);
    },
  },
]);
</script>

<style lang="scss" scoped>
.player-style-panel {
  box-sizing: border-box;
  width: min(260px, calc(100vw - 100px));
  padding: 10px;
  border-radius: 8px;
  color: rgb(var(--main-cover-color));
  .style-options {
    display: grid;
    align-content: start;
    gap: 4px;
    // 为六个歌词选项预留高度，切换 Tab 时保持弹层位置稳定。
    height: 260px;
    max-height: calc(100dvh - 160px);
    overflow-y: auto;
  }
  .style-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 40px;
    padding: 9px 12px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: rgba(var(--main-cover-color), 0.82);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s,
      color 0.15s;
    &:hover {
      background: rgba(var(--main-cover-color), 0.09);
      color: rgb(var(--main-cover-color));
    }
    &.selected {
      background: rgba(var(--main-cover-color), 0.16);
      color: rgb(var(--main-cover-color));
      font-weight: 500;
    }
    &:focus-visible {
      outline: 2px solid rgba(var(--main-cover-color), 0.8);
      outline-offset: -2px;
    }
  }
  .selection-mark {
    flex-shrink: 0;
    visibility: hidden;
    &.visible {
      visibility: visible;
    }
  }
}
</style>
