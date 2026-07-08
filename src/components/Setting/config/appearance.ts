import { useSettingStore, useStatusStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { openFontManager, openThemeConfig } from "@/utils/modal";
import { SettingConfig } from "@/types/settings";
import { computed, ref } from "vue";
import { t } from "@/i18n";

export const useAppearanceSettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const statusStore = useStatusStore();

  // --- Window / Borderless Logic (from general.ts) ---
  const useBorderless = ref(true);

  const handleBorderlessChange = async (val: boolean) => {
    if (!isElectron) return;
    const windowConfig = await window.api.store.get("window");
    window.api.store.set("window", {
      ...windowConfig,
      useBorderless: val,
    });
    window.$message.warning(t("message.setting_saved_and_restart_required"));
  };

  const onActivate = async () => {
    if (isElectron) {
      const windowConfig = await window.api.store.get("window");
      useBorderless.value = windowConfig?.useBorderless ?? true;
    }
  };

  return {
    onActivate,
    groups: [
      {
        title: t("setting.general.theme_setting"),
        items: [
          {
            key: "language",
            label: t("common.language"),
            type: "select",
            description: t("setting.general.language_tip"),
            options: [
              { label: "简体中文", value: "zh-CN" },
              { label: "English", value: "en" },
            ],
            value: computed({
              get: () => settingStore.language,
              set: (v) => (settingStore.language = v),
            }),
          },
          {
            key: "themeMode",
            label: t("setting.general.theme_mode"),
            type: "select",
            description: t("setting.general.theme_mode_tip"),
            options: [
              {
                label: t("setting.general.theme_mode_value_auto"),
                value: "auto",
              },
              {
                label: t("setting.general.theme_mode_value_light"),
                value: "light",
              },
              {
                label: t("setting.general.theme_mode_value_dark"),
                value: "dark",
              },
            ],
            value: computed({
              get: () => settingStore.themeMode,
              set: (v) => (settingStore.themeMode = v),
            }),
            forceIf: {
              condition: () => statusStore.isCustomBackground,
              forcedValue: "auto",
              forcedDescription: t("setting.general.theme_mode_disabled"),
            },
          },
          {
            key: "themeConfig",
            label: t("setting.general.theme_config"),
            type: "button",
            description: t("setting.general.theme_config_tip"),
            buttonLabel: t("common.configuration"),
            action: openThemeConfig,
          },
          {
            key: "useBorderless",
            label: t("setting.appearance.borderless_windows"),
            type: "switch",
            show: isElectron,
            description: t("setting.appearance.borderless_windows_tip"),
            value: computed({
              get: () => useBorderless.value,
              set: (v) => {
                useBorderless.value = v;
                handleBorderlessChange(v);
              },
            }),
          },
          {
            key: "fontConfig",
            label: t("setting.appearance.global_font"),
            type: "button",
            description: t("setting.appearance.global_font_tip"),
            buttonLabel: t("common.configuration"),
            action: openFontManager,
          },
        ],
      },
      {
        title: t("common.player"),
        items: [
          {
            key: "playerType",
            label: t("setting.play.player_type"),
            type: "select",
            description: t("setting.play.player_type_tip"),
            options: [
              {
                label: t("setting.play.player_tip_value_cover"),
                value: "cover",
              },
              {
                label: t("setting.play.player_tip_value_record"),
                value: "record",
              },
              { label: t("setting.play.player_tip_value_fullscreen"), value: "fullscreen" },
            ],
            value: computed({
              get: () => settingStore.playerType,
              set: (v) => (settingStore.playerType = v),
            }),
            condition: () => true,
          },
          {
            key: "playerBackgroundType",
            label: t("setting.play.player_background_type"),
            type: "select",
            description: t("setting.play.player_background_type_tip"),
            options: [
              {
                label: t("setting.play.player_background_type_value_animation"),
                value: "animation",
              },
              {
                label: t("setting.play.player_background_type_value_blur"),
                value: "blur",
              },
              {
                label: t("setting.play.player_background_type_value_color"),
                value: "color",
              },
              {
                label: t("setting.play.player_background_type_value_artist-photo"),
                value: "artist-photo",
              },
            ],
            value: computed({
              get: () => settingStore.playerBackgroundType,
              set: (v) => (settingStore.playerBackgroundType = v),
            }),
            condition: () => settingStore.playerBackgroundType === "animation",
            children: [
              {
                key: "playerBackgroundFps",
                label: t("setting.play.player_background_fps"),
                type: "input-number",
                description: t("setting.play.player_background_fps_tip"),
                min: 24,
                max: 256,
                show: () => settingStore.playerBackgroundType === "animation",
                value: computed({
                  get: () => settingStore.playerBackgroundFps,
                  set: (v) => (settingStore.playerBackgroundFps = v),
                }),
              },
              {
                key: "playerBackgroundFlowSpeed",
                label: t("setting.play.player_background_flow_speed"),
                type: "input-number",
                description: t("setting.play.player_background_flow_speed_tip"),
                min: 0.1,
                max: 10,
                show: () => settingStore.playerBackgroundType === "animation",
                value: computed({
                  get: () => settingStore.playerBackgroundFlowSpeed,
                  set: (v) => (settingStore.playerBackgroundFlowSpeed = v),
                }),
              },
            ],
          },
          {
            key: "playerMainColorType",
            label: t("setting.play.player_main_color_type"),
            type: "select",
            options: [
              {
                label: t("setting.play.player_main_color_type_value_default"),
                value: "default",
              },
              {
                label: t("setting.play.player_main_color_type_value_follow_cover"),
                value: "follow-cover",
              },
              {
                label: t("setting.play.player_main_color_type_value_follow-theme"),
                value: "follow-theme",
              },
              {
                label: t("setting.play.player_main_color_type_value_custom"),
                value: "custom",
              },
            ],
            value: computed({
              get: () => settingStore.playerMainColorType,
              set: (v) => (settingStore.playerMainColorType = v),
            }),
            condition: () => settingStore.playerMainColorType === "custom",
            children: [
              {
                key: "playerMainColor",
                label: t("setting.play.player_main_color_custom"),
                type: "color-picker",
                componentProps: { showAlpha: false, modes: ["hex"] },
                show: () => settingStore.playerMainColorType === "custom",
                value: computed({
                  get: () => settingStore.playerMainColorCustom,
                  set: (v) => (settingStore.playerMainColorCustom = v),
                }),
              },
            ],
          },
          {
            key: "playerExpandAnimation",
            label: t("setting.appearance.player_expand_animation"),
            type: "select",
            description: t("setting.appearance.player_expand_animation_tip"),
            options: [
              { label: t("setting.appearance.player_expand_animation_value_up"), value: "up" },
              { label: t("setting.appearance.player_expand_animation_value_flow"), value: "flow" },
            ],
            value: computed({
              get: () => settingStore.playerExpandAnimation,
              set: (v) => (settingStore.playerExpandAnimation = v),
            }),
          },
          {
            key: "showSpectrums",
            label: t("setting.play.show_spectrum"),
            type: "switch",
            show: isElectron,
            description: t("setting.play.show_spectrum_tip"),
            value: computed({
              get: () => settingStore.showSpectrums,
              set: (v) => (settingStore.showSpectrums = v),
            }),
          },
        ],
      },
    ],
  };
};
