<template>
  <div class="setting">
    <n-tabs
      v-model:value="activeKey"
      class="tabs"
      type="card"
      animated
      default-value="song"
      @update:value="tabChange"
    >
      <n-tab-pane
        name="general"
        :tab="t('setting.general.general_setting')"
        display-directive="show:lazy"
      >
        <!-- 常规 -->
        <UniversalSetting :groups="generalConfig.groups" />
      </n-tab-pane>
      <!-- 外观 -->
      <n-tab-pane
        name="appearance"
        :tab="t('setting.appearance.appearance_setting')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="appearanceConfig.groups" />
      </n-tab-pane>
      <!-- 播放 -->
      <n-tab-pane name="play" :tab="t('setting.play.play_setting')" display-directive="show:lazy">
        <UniversalSetting :groups="playConfig.groups" />
      </n-tab-pane>
      <!-- 歌词 -->
      <n-tab-pane
        name="lyrics"
        :tab="t('setting.lyrics.lyrics_setting')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="lyricConfig.groups" />
      </n-tab-pane>
      <!-- 快捷键 -->
      <n-tab-pane
        v-if="isElectron"
        name="shortcut"
        :tab="t('setting.shortcut.shortcut_setting')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="keyboardConfig.groups" />
      </n-tab-pane>
      <!-- 本地 -->
      <n-tab-pane
        v-if="isElectron"
        name="local"
        :tab="t('setting.local.local_setting')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="localConfig.groups" />
      </n-tab-pane>
      <n-tab-pane
        name="network"
        :tab="t('setting.network.network_and_connect')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="networkConfig.groups" />
      </n-tab-pane>
      <n-tab-pane name="about" :tab="t('common.about')" display-directive="show:lazy">
        <!-- 关于 -->
        <AboutSetting />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import type { SettingType } from "@/types/main";
import { useI18n } from "vue-i18n";
import { computed } from "vue";
import { isElectron } from "@/utils/env";
import { usePlaySettings } from "@/components/Setting/config/play";
import { useGeneralSettings } from "@/components/Setting/config/general";
import { useAppearanceSettings } from "@/components/Setting/config/appearance";
import { useLyricSettings } from "@/components/Setting/config/lyric";
import { useKeyboardSettings } from "@/components/Setting/config/keyboard";
import { useLocalSettings } from "@/components/Setting/config/local";
import { useNetworkSettings } from "@/components/Setting/config/network";

const { t } = useI18n();
const router = useRouter();

// 菜单数据
const activeKey = computed<SettingType>(
  () => (router.currentRoute.value.query.type as SettingType) || "general",
);

const playConfig = computed(() => usePlaySettings());
const generalConfig = computed(() => useGeneralSettings());
const appearanceConfig = computed(() => useAppearanceSettings());
const lyricConfig = computed(() => useLyricSettings());
const keyboardConfig = computed(() => useKeyboardSettings());
const localConfig = computed(() => useLocalSettings());
const networkConfig = computed(() => useNetworkSettings());

const tabChange = (key: SettingType) => {
  router.push({
    path: "/setting",
    query: {
      type: key,
    },
  });
};
</script>

<style lang="scss" scoped>
.setting {
  display: flex;
  width: 100%;
  overflow: scroll;
  :deep(.n-tabs-pane-wrapper) {
    padding: 0;
    .setting-type {
      transition: opacity 0.2s ease-in-out;
    }
    .set-content {
      flex: 1;
      padding: 0 40px;
      background-color: var(--background-hex);
      // background-color: rgba(var(--surface-container), 0.28);
    }
    .set-list {
      margin-bottom: 30px;
      &:last-child {
        margin-bottom: 0;
      }
    }
    .n-collapse-transition {
      margin-bottom: 12px;
      &:last-child {
        margin-bottom: 0;
      }
    }
    .set-item {
      width: 100%;
      border-radius: 8px;
      margin-bottom: 12px;
      transition: margin 0.3s;
      &:last-child {
        margin-bottom: 0;
      }
      .n-card__content {
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        padding: 16px;
      }
      .label {
        display: flex;
        flex-direction: column;
        padding-right: 20px;
        .name {
          font-size: 16px;
        }
      }
      .n-flex {
        flex-flow: nowrap !important;
      }
      .set {
        justify-content: flex-end;
        width: 200px;
        &.n-switch {
          width: max-content;
        }
      }
    }
  }
}
</style>
