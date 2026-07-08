<template>
  <n-scrollbar style="max-height: 70vh" class="font-manager">
    <div class="set-list">
      <n-h3 prefix="bar">{{ t("setting.appearance.global_font") }}</n-h3>
      <n-card class="set-item">
        <div class="label">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <div class="info" style="display: flex; flex-direction: column">
              <n-text class="name">{{ t("setting.appearance.global_font") }}</n-text>
            </div>
            <Transition name="fade" mode="out-in">
              <n-button
                :disabled="settingStore.globalFont === 'default'"
                type="primary"
                strong
                secondary
                @click="settingStore.globalFont = 'default'"
              >
                {{ t("common.reset_default") }}
              </n-button>
            </Transition>
          </div>
        </div>
        <n-select
          :value="getUIValue('globalFont')"
          :options="[
            {
              label: t('common.system_default'),
              value: 'default',
            },
            ...systemFonts,
          ]"
          class="set"
          filterable
          @update:value="(v, opt) => handleFontChange('globalFont', v, opt)"
        />
      </n-card>
    </div>
    <div class="set-list" v-if="isElectron">
      <n-h3 prefix="bar">{{ t("common.desktop_lyrics") }}</n-h3>
      <n-card class="set-item">
        <div class="label">
          <div class="label-header">
            <div class="info" style="display: flex; flex-direction: column">
              <n-text class="name">{{ t("setting.lyrics.desktop_lyrics_font_family") }}</n-text>
              <n-text class="tip" :depth="3">
                {{ t("setting.lyrics.desktop_lyrics_font_family_tip") }}
              </n-text>
            </div>
            <Transition name="fade" mode="out-in">
              <n-button
                :disabled="desktopLyricConfig.font.postScriptName === 'system-ui'"
                type="primary"
                strong
                secondary
                @click="
                  () => {
                    desktopLyricConfig.font.postScriptName = 'system-ui';
                    Object.assign(desktopLyricConfig.font, {
                      family: 'system-ui',
                      weight: 400,
                      style: 'normal',
                    });
                    saveDesktopLyricConfig();
                  }
                "
              >
                {{ t("common.reset_default") }}
              </n-button>
            </Transition>
          </div>
        </div>
        <n-flex align="center">
          <n-select
            :value="getUIValue('desktopLyric')"
            :options="[
              {
                label: t('common.system_default'),
                value: 'system-ui',
                fontStyleSelection: {
                  family: 'system-ui',
                  weight: 400,
                  style: 'normal',
                  postscriptName: 'system-ui',
                },
              },
              ...systemFonts,
            ]"
            class="set"
            filterable
            @update:value="(v, opt) => handleFontChange('desktopLyric', v, opt)"
          />
        </n-flex>
      </n-card>
    </div>
    <div class="set-list">
      <n-h3 prefix="bar">{{ t("setting.general.lyric_font") }}</n-h3>
      <n-card v-for="font in lyricFontConfigs" :key="font.keySetting" class="set-item">
        <div class="label">
          <div class="label-header">
            <div class="info" style="display: flex; flex-direction: column">
              <n-text class="name">{{ t(`setting.general.${snakeCase(font.keySetting)}`) }}</n-text>
            </div>
            <Transition name="fade" mode="out-in">
              <n-button
                :disabled="settingStore[font.keySetting] === font.default"
                type="primary"
                strong
                secondary
                @click="settingStore[font.keySetting] = font.default"
              >
                {{ t("common.reset_default") }}
              </n-button>
            </Transition>
          </div>
        </div>
        <n-flex align="center">
          <n-select
            :value="getUIValue(font.keySetting)"
            :options="[
              {
                label: t('setting.general.lyric_font_follow_global'),
                value: 'follow',
              },
              ...systemFonts,
            ]"
            class="set"
            filterable
            @update:value="(v, opt) => handleFontChange(font.keySetting, v, opt)"
          />
        </n-flex>
      </n-card>
    </div>
  </n-scrollbar>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import type { SelectOption } from "naive-ui";
import { LyricFontConfig, lyricFontConfigs } from "@/utils/lyric/lyricFontConfig";
import { LyricConfig } from "@/types/desktop-lyric";
import defaultDesktopLyricConfig from "@/assets/data/lyricConfig";
import { cloneDeep, isEqual, snakeCase } from "lodash-es";
import { useI18n } from "vue-i18n";
import { FontData, FontStyleSelection } from "@/types/global";
import { parseFontDataStyle } from "@/utils/helper";

const { t } = useI18n();
const settingStore = useSettingStore();

type LyricKey = LyricFontConfig["keySetting"] | "globalFont" | "desktopLyric";

// 系统字体选项
const systemFonts = ref<SelectOption[]>([]);

// 桌面歌词配置
const desktopLyricConfig = reactive<LyricConfig>({ ...defaultDesktopLyricConfig });

const getUIValue = (key: LyricKey) => {
  if (key === "desktopLyric") return desktopLyricConfig.font.postScriptName;
  const val = settingStore[key];
  if (val === "default" || val === "follow") return val; // 'default' 或 'follow'
  return val.postscriptName;
};

/**
 * 统一更新函数：支持普通 Store 字段 和 桌面歌词特殊对象
 */
const handleFontChange = (key: LyricKey, value: string, option: any) => {
  const selection = option.fontStyleSelection as FontStyleSelection;

  // 情况 A: 更新桌面歌词 (Nested Object)
  if (key === "desktopLyric") {
    Object.assign(desktopLyricConfig.font, {
      family: selection.family,
      weight: selection.weight,
      style: selection.style,
      postScriptName: selection.postscriptName,
    });
    saveDesktopLyricConfig();
    return;
  }
  if (value === "default" || value === "follow") {
    (settingStore as any)[key] = value;
  } else {
    (settingStore as any)[key] = selection;
  }
};

// 获取全部系统字体
const getAllSystemFonts = async () => {
  await getWebSystemFonts();
  if (systemFonts.value.length > 0) return;
  if (!isElectron) {
    return;
  }
  try {
    const allFonts = await window.electron.ipcRenderer.invoke("get-all-fonts");
    systemFonts.value = allFonts
      .sort((a: any, b: any) => a.name.localeCompare(b.name))
      .map((v: any) => {
        const fontWeight = parseFontDataStyle(v.weight).fontWeight;
        const fontStyle = parseFontDataStyle(v.style).fontStyle;
        return {
          label: v.name,
          value: v.postScriptName,
          style: {
            fontFamily: v.familyName,
            fontWeight,
            fontStyle,
          },
          fontStyleSelection: {
            family: v.familyName,
            weight: fontWeight,
            style: fontStyle,
            postscriptName: v.postScriptName,
          },
        };
      });
  } catch (error) {
    console.error("Failed to get system fonts:", error);
  }
};

// 获取全部系统字体
const getWebSystemFonts = async () => {
  if (!window.queryLocalFonts) return;
  try {
    const fonts = await window.queryLocalFonts();
    systemFonts.value = fonts
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((v: FontData) => {
        const { fontWeight, fontStyle } = parseFontDataStyle(v.style);
        return {
          label: v.fullName,
          value: v.postscriptName,
          style: {
            fontFamily: v.family,
            fontWeight,
            fontStyle,
          },
          fontStyleSelection: {
            family: v.family,
            weight: fontWeight,
            style: fontStyle,
            postscriptName: v.postscriptName,
          },
        };
      });
    console.log("systemFonts:", systemFonts.value);
  } catch (error) {
    window.$message.error(t("message.get_web_font_fail"));
    console.error("Failed to get system fonts:", error);
  }
};
// 获取桌面歌词配置
const getDesktopLyricConfig = async () => {
  if (!isElectron) return;
  const config = await window.electron.ipcRenderer.invoke("request-desktop-lyric-option");
  if (config) Object.assign(desktopLyricConfig, config);
  // 监听更新
  window.electron.ipcRenderer.on("update-desktop-lyric-option", (_, config) => {
    if (config && !isEqual(desktopLyricConfig, config)) {
      Object.assign(desktopLyricConfig, config);
    }
  });
};

// 保存桌面歌词配置
const saveDesktopLyricConfig = () => {
  try {
    if (!isElectron) return;
    window.electron.ipcRenderer.send(
      "update-desktop-lyric-option",
      cloneDeep(desktopLyricConfig),
      true,
    );
    window.$message.success(t("message.desktop_lyrics_save_success"));
  } catch (error) {
    console.error("Failed to save options:", error);
    window.$message.error(t("message.desktop_lyrics_save_fail"));
    getDesktopLyricConfig();
  }
};

onMounted(() => {
  getAllSystemFonts();
  getDesktopLyricConfig();
});
</script>

<style lang="scss" scoped>
.font-manager {
  .set-list {
    margin-bottom: 24px;
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
    :deep(.n-card__content) {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
    }
    .label {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding-right: 20px;
      .label-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
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
      @media (max-width: 768px) {
        width: 140px;
        min-width: 140px;
      }
    }
  }
}
</style>
