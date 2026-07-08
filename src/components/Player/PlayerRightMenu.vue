<template>
  <n-flex :size="8" align="center" class="right-menu">
    <n-badge v-if="isElectron" value="ON" :show="statusStore.showDesktopLyric">
      <div class="menu-icon hidden" @click.stop="player.toggleDesktopLyric()">
        <SvgIcon name="DesktopLyric2" :depth="statusStore.showDesktopLyric ? 1 : 3" />
      </div>
    </n-badge>
    <!-- 音质切换 -->
    <n-dropdown
      :options="getQualityMenuOptions(musicStore.playSong)"
      :show-arrow="true"
      :disabled="musicStore.isLocalSong"
      @select="(quality) => player.changeQuality(quality)"
      :class="{ player: statusStore.showFullPlayer }"
    >
      <div class="menu-icon quality-selector hidden">
        <span class="current-quality">{{ statusStore.playQuality }}</span>
      </div>
    </n-dropdown>
    <!-- 播放模式 -->
    <n-dropdown
      v-if="!statusStore.radioMode"
      :options="playModeOptions"
      :show-arrow="false"
      :class="{ player: statusStore.showFullPlayer }"
      @select="(mode) => player.togglePlayMode(mode)"
    >
      <div class="menu-icon play-mode hidden" @click.stop="player.togglePlayMode(false)">
        <SvgIcon :name="statusStore.playModeIcon" />
      </div>
    </n-dropdown>

    <!-- 其他控制 -->
    <n-dropdown
      :options="controlsOptions"
      :show-arrow="false"
      :class="{ player: statusStore.showFullPlayer }"
      @select="handleControls"
    >
      <div class="menu-icon hidden">
        <SvgIcon name="Controls" />
      </div>
    </n-dropdown>
    <!-- 音量 -->
    <n-popover
      :show-arrow="false"
      :style="{ padding: 0 }"
      :class="{ player: statusStore.showFullPlayer }"
    >
      <template #trigger>
        <div class="menu-icon hidden" @click.stop="player.toggleMute" @wheel="player.setVolume">
          <SvgIcon :name="statusStore.playVolumeIcon" />
        </div>
      </template>
      <div class="volume-change" @wheel="player.setVolume">
        <n-slider
          v-model:value="statusStore.playVolume"
          :tooltip="false"
          :min="0"
          :max="1"
          :step="0.01"
          vertical
          @update:value="(val: number) => player.setVolume(val)"
        />
        <n-text class="slider-num hidden">{{ statusStore.playVolumePercent }}%</n-text>
      </div>
    </n-popover>
    <!-- 播放列表 -->
    <n-badge
      v-if="!statusStore.radioMode"
      :value="dataStore.playList?.length ?? 0"
      :show="settingStore.showPlaylistCount"
      :max="9999"
      :style="{
        marginRight: settingStore.showPlaylistCount ? '12px' : null,
      }"
    >
      <div class="menu-icon" @click.stop="statusStore.playListShow = !statusStore.playListShow">
        <SvgIcon name="PlayList" />
      </div>
    </n-badge>
  </n-flex>
</template>

<script setup lang="ts">
import { useDataStore, useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { renderIcon } from "@/utils/helper";
import { openAutoClose, openChangeRate, openEqualizer } from "@/utils/modal";
import type { DropdownOption } from "naive-ui";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
import { useSongMenu } from "@/composables/useSongMenu";

const { t } = useI18n();

const dataStore = useDataStore();
const statusStore = useStatusStore();
const settingStore = useSettingStore();
const musicStore = useMusicStore();
const player = usePlayer();

const { getQualityMenuOptions } = useSongMenu();
const playModeOptions = computed(() => [
  {
    label: t("common.play_mode_repeat"),
    key: "repeat",
    icon: renderIcon("Repeat"),
  },
  {
    label: t("common.play_mode_repeat_once"),
    key: "repeat-once",
    icon: renderIcon("RepeatSong"),
  },
  {
    label: t("common.play_mode_shuffle"),
    key: "shuffle",
    icon: renderIcon("Shuffle"),
  },
]);

// 更多功能
const controlsOptions = computed<DropdownOption[]>(() => [
  {
    label: t("common.equalizer"),
    key: "equalizer",
    icon: renderIcon("Eq"),
  },
  {
    label: t("common.auto_close"),
    key: "autoClose",
    icon: renderIcon("TimeAuto"),
  },
  {
    label: t("common.play_rate"),
    key: "rate",
    icon: renderIcon("PlayRate"),
  },
]);

// 更多功能选择
const handleControls = (key: string) => {
  switch (key) {
    case "equalizer":
      openEqualizer();
      break;
    case "autoClose":
      openAutoClose();
      break;
    case "rate":
      openChangeRate();
      break;
  }
};
</script>

<style scoped lang="scss">
.right-menu {
  .menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    border-radius: 8px;
    transition:
      background-color 0.3s,
      transform 0.3s;
    cursor: pointer;
    .n-icon {
      font-size: 22px;
      color: var(--primary-hex);
    }
    &:hover {
      transform: scale(1.1);
      background-color: rgba(var(--primary), 0.28);
    }
    &:active {
      transform: scale(1);
    }
  }
  :deep(.n-badge-sup) {
    background-color: rgba(var(--primary), 0.28);
    backdrop-filter: blur(20px);
    // font-size: 10px;
    .n-base-slot-machine {
      color: var(--primary-hex);
    }
  }
  .quality-selector {
    display: flex;
    align-items: center;
  }

  .current-quality {
    font-size: 10px;
    font-weight: 500;
    color: var(--primary-hex);
  }
  .play-pause {
    display: none;
  }
  @media (max-width: 810px) {
    .hidden {
      display: none;
    }
  }
}
.volume-change {
  padding: 12px;
  display: flex;
  flex-direction: column;
  height: 180px;
  width: 58px;
  align-items: center;
  .slider-num {
    margin-top: 8px;
    font-size: 13px;
    color: var(--color);
    white-space: nowrap;
  }
}
</style>
