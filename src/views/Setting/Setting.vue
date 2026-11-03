<template>
  <div class="setting">
    <n-tabs v-model:value="activeKey" class="tabs" type="card" animated default-value="general">
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
        v-if="isMygo"
        name="keyboard"
        :tab="t('setting.shortcut.shortcut_setting')"
        display-directive="show:lazy"
      >
        <UniversalSetting :groups="keyboardConfig.groups" />
      </n-tab-pane>
      <!-- 本地 -->
      <n-tab-pane
        v-if="isMygo"
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
import type { SettingConfig } from "@/types/settings";
import { useI18n } from "vue-i18n";
import { computed, type ComputedRef } from "vue";
import { useScopedSettingConfig, useSettingActivation } from "@/composables/useSettingLifecycle";
import { isMygo } from "@/utils/env";
import { usePlaySettings } from "@/components/Setting/config/play";
import { useGeneralSettings } from "@/components/Setting/config/general";
import { useGeneralSettingsActions } from "@/components/Setting/config/generalActions";
import { useAppearanceSettings } from "@/components/Setting/config/appearance";
import { useLyricSettings } from "@/components/Setting/config/lyric";
import { useKeyboardSettings } from "@/components/Setting/config/keyboard";
import { useLocalSettings } from "@/components/Setting/config/local";
import { useNetworkSettings } from "@/components/Setting/config/network";

const { t } = useI18n();
const router = useRouter();

// 菜单数据
const settingTypes: readonly SettingType[] = [
  "general",
  "appearance",
  "play",
  "lyrics",
  "keyboard",
  "local",
  "network",
  "about",
];
const activeKey = computed<SettingType>({
  get: () => {
    const value = router.currentRoute.value.query.type;
    if (value === "shortcut") return "keyboard";
    return settingTypes.find((type) => type === value) ?? "general";
  },
  set: (value) => tabChange(value),
});

const generalActions = useGeneralSettingsActions();
const playConfig = useScopedSettingConfig(() => usePlaySettings());
const generalConfig = useScopedSettingConfig(() => useGeneralSettings(generalActions));
const appearanceConfig = useScopedSettingConfig(() => useAppearanceSettings());
const lyricConfig = useScopedSettingConfig(() => useLyricSettings());
const keyboardConfig = useScopedSettingConfig(() => useKeyboardSettings());
const localConfig = useScopedSettingConfig(() => useLocalSettings());
const networkConfig = useScopedSettingConfig(() => useNetworkSettings());
const configs: Readonly<Record<string, ComputedRef<SettingConfig> | undefined>> = {
  general: generalConfig,
  appearance: appearanceConfig,
  play: playConfig,
  lyrics: lyricConfig,
  keyboard: keyboardConfig,
  local: localConfig,
  network: networkConfig,
};
useSettingActivation(computed(() => configs[activeKey.value]?.value));

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
      .n-card-content {
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
