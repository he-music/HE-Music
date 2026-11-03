import { useSettingStore, useStatusStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { openFontManager, openThemeConfig } from "@/utils/modal";
import { SettingConfig } from "@/types/settings";
import { computed, ref } from "vue";
import { t } from "@/i18n";
import { platform } from "@/platform";
import { windowAppearanceSession } from "@/platform/windowAppearance";
import { linuxGraphicsSession } from "@/platform/linuxGraphics";

export const useAppearanceSettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const statusStore = useStatusStore();

  // --- Window / Borderless Logic (from general.ts) ---
  const useBorderless = ref(true);
  let active = false;
  let activation = 0;

  const handleBorderlessChange = async (val: boolean) => {
    if (platform.kind === "mygo") {
      const session = windowAppearanceSession.value;
      if (!session) return;
      const generation = activation;
      try {
        const state = await session.save(val);
        if (
          !state ||
          !active ||
          generation !== activation ||
          windowAppearanceSession.value !== session
        )
          return;
        if (state.restartRequired) {
          window.$message.warning(t("message.setting_saved_and_restart_required"));
        } else {
          window.$message.success(t("mygo.window_appearance.saved"));
        }
      } catch {
        if (active && generation === activation && windowAppearanceSession.value === session) {
          window.$message.error(t("mygo.window_appearance.save_failed"));
        }
      }
      return;
    }
    if (!isElectron) return;
    const windowConfig = await window.api.store.get("window");
    window.api.store.set("window", {
      ...windowConfig,
      useBorderless: val,
    });
    window.$message.warning(t("message.setting_saved_and_restart_required"));
  };

  const handleGraphicsChange = async (enabled: boolean) => {
    const session = linuxGraphicsSession.value;
    if (!session) return;
    const generation = activation;
    try {
      const state = await session.save(enabled);
      if (!state || !active || generation !== activation || linuxGraphicsSession.value !== session)
        return;
      if (state.restartRequired) {
        window.$message.warning(t("message.setting_saved_and_restart_required"));
      } else {
        window.$message.success(t("mygo.linux_graphics.saved"));
      }
    } catch {
      if (active && generation === activation && linuxGraphicsSession.value === session) {
        window.$message.error(t("mygo.linux_graphics.save_failed"));
      }
    }
  };
  const refreshGraphics = async (generation: number) => {
    const session = linuxGraphicsSession.value;
    if (!session) return;
    try {
      await session.refresh();
    } catch {
      if (active && generation === activation && linuxGraphicsSession.value === session) {
        window.$message.error(t("mygo.linux_graphics.load_failed"));
      }
    }
  };

  const onActivate = async () => {
    active = true;
    const generation = ++activation;
    if (platform.kind === "mygo" && platform.os === "linux") void refreshGraphics(generation);
    if (platform.kind === "mygo") {
      const session = windowAppearanceSession.value;
      if (!session) return;
      try {
        await session.refresh();
      } catch {
        if (active && generation === activation && windowAppearanceSession.value === session) {
          window.$message.error(t("mygo.window_appearance.load_failed"));
        }
      }
      return;
    }
    if (isElectron) {
      const windowConfig = await window.api.store.get("window");
      useBorderless.value = windowConfig?.useBorderless ?? true;
    }
  };

  return {
    onActivate,
    onDeactivate: () => {
      active = false;
      activation++;
    },
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
            show: isElectron || Boolean(platform.windowAppearance),
            description: computed(() =>
              platform.kind === "mygo"
                ? t(
                    windowAppearanceSession.value?.state.value?.loadFailed
                      ? "mygo.window_appearance.load_default"
                      : "mygo.window_appearance.restart_tip",
                  )
                : t("setting.appearance.borderless_windows_tip"),
            ),
            disabled: computed(
              () =>
                platform.kind === "mygo" &&
                (!windowAppearanceSession.value?.state.value ||
                  windowAppearanceSession.value.saving.value),
            ),
            value: computed({
              get: () =>
                platform.kind === "mygo"
                  ? (windowAppearanceSession.value?.state.value?.useBorderless ?? false)
                  : useBorderless.value,
              set: (v) => {
                if (isElectron) useBorderless.value = v;
                handleBorderlessChange(v);
              },
            }),
          },
          {
            key: "linuxGraphicsCompatibility",
            label: t("mygo.linux_graphics.title"),
            type: "switch",
            show:
              platform.kind === "mygo" &&
              platform.os === "linux" &&
              Boolean(platform.linuxGraphics),
            description: computed(() => {
              const state = linuxGraphicsSession.value?.state.value;
              return t(
                state?.loadFailed ? "mygo.linux_graphics.load_default" : "mygo.linux_graphics.tip",
                {
                  mode: t(
                    state?.applied
                      ? "mygo.linux_graphics.compatible"
                      : "mygo.linux_graphics.normal",
                  ),
                },
              );
            }),
            disabled: computed(
              () =>
                !linuxGraphicsSession.value?.state.value || linuxGraphicsSession.value.saving.value,
            ),
            value: computed({
              get: () => linuxGraphicsSession.value?.state.value?.enabled ?? false,
              set: handleGraphicsChange,
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
