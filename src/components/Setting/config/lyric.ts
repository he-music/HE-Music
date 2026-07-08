import { useSettingStore, useStatusStore } from "@/stores";
import { LyricConfig } from "@/types/desktop-lyric";
import { isElectron } from "@/utils/env";
import { openExcludeLyric, openFontManager } from "@/utils/modal";
import { cloneDeep, isEqual } from "lodash-es";
import defaultDesktopLyricConfig from "@/assets/data/lyricConfig";
import { SettingConfig } from "@/types/settings";
import LyricPreview from "../components/LyricPreview.vue";
import { t } from "@/i18n";
import { usePlayer } from "@/utils/player";

export const useLyricSettings = (): SettingConfig => {
  const player = usePlayer();
  const statusStore = useStatusStore();
  const settingStore = useSettingStore();

  // 桌面歌词配置
  const desktopLyricConfig = reactive<LyricConfig>({ ...defaultDesktopLyricConfig });

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
      console.log(cloneDeep(desktopLyricConfig));
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

  // 恢复默认桌面歌词配置
  const restoreDesktopLyricConfig = () => {
    try {
      if (!isElectron) return;
      window.$dialog.warning({
        title: t("common.warning"),
        content: t("message.desktop_lyrics_reset_confirm"),
        positiveText: t("common.ok"),
        negativeText: t("common.cancel"),
        onPositiveClick: () => {
          window.electron.ipcRenderer.send(
            "update-desktop-lyric-option",
            defaultDesktopLyricConfig,
            true,
          );
          window.$message.success(t("message.desktop_lyrics_reset_success"));
          console.log(defaultDesktopLyricConfig, desktopLyricConfig);
        },
      });
    } catch (error) {
      console.error("Failed to save options:", error);
      window.$message.error(t("message.desktop_lyrics_reset_fail"));
      getDesktopLyricConfig();
    }
  };

  // 重置桌面歌词位置
  const resetDesktopLyricWindow = () => {
    try {
      if (!isElectron) return;
      window.electron.ipcRenderer.invoke("reset-desktop-lyric-window");
      window.$message.success(t("message.desktop_lyrics_position_reset_success"));
    } catch (error) {
      console.error("Failed to reset desktop lyric window:", error);
      window.$message.error(t("message.desktop_lyrics_position_reset_fail"));
    }
  };

  const onActivate = async () => {
    if (isElectron) {
      getDesktopLyricConfig();
    }
  };

  return {
    onActivate,
    groups: [
      {
        title: t("setting.lyrics.lyrics_setting"),
        items: [
          {
            key: "lyricPreview",
            label: t("common.preview"),
            type: "custom",
            noWrapper: true,
            component: markRaw(LyricPreview),
          },
          {
            key: "lyricFontSize",
            label: t("setting.lyrics.lyrics_font_size"),
            type: "input-number",
            description: t("setting.lyrics.lyrics_font_size_tip"),
            min: 12,
            max: 60,
            suffix: "px",
            value: computed({
              get: () => settingStore.lyricFontSize,
              set: (v) => (settingStore.lyricFontSize = v || 30),
            }),
            defaultValue: 46,
          },
          {
            key: "lyricTranFontSize",
            label: t("setting.lyrics.lyrics_tran_font_size"),
            type: "input-number",
            description: t("setting.lyrics.lyrics_tran_font_size_tip"),
            min: 5,
            max: 40,
            suffix: "px",
            value: computed({
              get: () => settingStore.lyricTranFontSize,
              set: (v) => (settingStore.lyricTranFontSize = v || 22),
            }),
            forceIf: {
              condition: () => settingStore.useAMLyrics,
              forcedValue: () => Math.max(0.5 * settingStore.lyricFontSize, 10),
            },
            defaultValue: 22,
          },
          {
            key: "lyricRomaFontSize",
            label: t("setting.lyrics.lyrics_roma_font_size"),
            type: "input-number",
            description: t("setting.lyrics.lyrics_roma_font_size_tip"),
            min: 5,
            max: 40,
            suffix: "px",
            value: computed({
              get: () => settingStore.lyricRomaFontSize,
              set: (v) => (settingStore.lyricRomaFontSize = v || 18),
            }),
            forceIf: {
              condition: () => settingStore.useAMLyrics,
              forcedValue: () => Math.max(0.5 * settingStore.lyricFontSize, 10),
            },
            defaultValue: 18,
          },
          {
            key: "fontConfig",
            label: t("setting.lyrics.font_config"),
            type: "button",
            description: t("setting.lyrics.font_config_tip"),
            buttonLabel: t("common.configuration"),
            action: openFontManager,
          },
          {
            key: "lyricsPosition",
            label: t("setting.lyrics.lyrics_position"),
            type: "select",
            description: t("setting.lyrics.lyrics_position_tip"),
            options: [
              {
                label: t("setting.lyrics.lyrics_position_value_left"),
                value: "flex-start",
              },
              {
                label: t("setting.lyrics.lyrics_position_value_center"),
                value: "center",
              },
              {
                label: t("setting.lyrics.lyrics_position_value_right"),
                value: "flex-end",
              },
            ],
            value: computed({
              get: () => settingStore.lyricsPosition,
              set: (v) => (settingStore.lyricsPosition = v),
            }),
            forceIf: {
              condition: () => settingStore.useAMLyrics,
              forcedValue: "flex-start",
            },
          },
          {
            key: "lyricsScrollOffset",
            label: t("setting.lyrics.lyrics_scroll_position"),
            type: "slider",
            description: t("setting.lyrics.lyrics_scroll_position_tip"),
            min: 0.1,
            max: 0.9,
            step: 0.05,
            marks: {
              0.1: t("setting.lyrics.lyrics_scroll_position_up"),
              0.9: t("setting.lyrics.lyrics_scroll_position_down"),
            },
            formatTooltip: (v) => `${(v * 100).toFixed(0)}%`,
            value: computed({
              get: () => settingStore.lyricsScrollOffset,
              set: (v) => (settingStore.lyricsScrollOffset = v),
            }),
          },
          {
            key: "showYrc",
            label: t("setting.lyrics.show_font_lyrics_animation"),
            type: "switch",
            description: t("setting.lyrics.show_font_lyrics_animation_tip"),
            value: computed({
              get: () => settingStore.showYrc,
              set: (v) => (settingStore.showYrc = v),
            }),
          },
          {
            key: "showTran",
            label: t("setting.lyrics.show_lyrics_trans"),
            type: "switch",
            value: computed({
              get: () => settingStore.showTran,
              set: (v) => (settingStore.showTran = v),
            }),
          },
          {
            key: "showRoma",
            label: t("setting.lyrics.show_lyrics_roma"),
            type: "switch",
            value: computed({
              get: () => settingStore.showRoma,
              set: (v) => (settingStore.showRoma = v),
            }),
          },
          // {
          //   key: "swapTranRoma",
          //   label: "调换翻译与音译位置",
          //   type: "switch",
          //   description: "开启后音译显示在翻译上方",
          //   value: computed({
          //     get: () => settingStore.swapTranRoma,
          //     set: (v) => (settingStore.swapTranRoma = v),
          //   }),
          //   forceIf: {
          //     condition: () => !settingStore.showTran || !settingStore.showRoma,
          //     forcedValue: false,
          //   },
          // },
          {
            key: "lyricsBlur",
            label: t("setting.lyrics.lyrics_blur"),
            type: "switch",
            description: t("setting.lyrics.lyrics_blur_tip"),
            value: computed({
              get: () => settingStore.lyricsBlur,
              set: (v) => (settingStore.lyricsBlur = v),
            }),
          },
        ],
      },
      {
        title: t("setting.lyrics.content"),
        items: [
          {
            key: "configExcludeLyric",
            label: t("setting.lyrics.lyrics_exclude"),
            type: "button",
            description: t("setting.lyrics.lyrics_exclude_tip"),
            buttonLabel: t("common.configuration"),
            action: openExcludeLyric,
          },
        ],
      },
      {
        title: "Apple Music-like Lyrics",
        tags: [{ text: "Beta", type: "warning" }],
        items: [
          {
            key: "useAMLyrics",
            label: t("setting.lyrics.use_am_lyrics"),
            type: "switch",
            description: t("setting.lyrics.use_am_lyrics_tip"),
            value: computed({
              get: () => settingStore.useAMLyrics,
              set: (v) => (settingStore.useAMLyrics = v),
            }),
            children: [
              {
                key: "useAMSpring",
                label: t("setting.lyrics.am_lyrics_spring"),
                type: "switch",
                description: t("setting.lyrics.am_lyrics_spring_tip"),
                value: computed({
                  get: () => settingStore.useAMSpring,
                  set: (v) => (settingStore.useAMSpring = v),
                }),
              },
              {
                key: "hidePassedLines",
                label: t("setting.lyrics.am_hide_passed_lines"),
                type: "switch",
                value: computed({
                  get: () => settingStore.AMHidePassedLines,
                  set: (v) => (settingStore.AMHidePassedLines = v),
                }),
              },
              {
                key: "wordFadeWidth",
                label: t("setting.lyrics.am_word_fade_width"),
                type: "input-number",
                description: t("setting.lyrics.am_word_fade_width_tip"),
                min: 0.01,
                max: 1,
                step: 0.01,
                value: computed({
                  get: () => settingStore.AMWordFadeWidth,
                  set: (v) => (settingStore.AMWordFadeWidth = v),
                }),
              },
            ],
          },
        ],
      },
      {
        title: t("common.desktop_lyrics"),
        tags: [{ text: "Beta", type: "warning" }],
        show: isElectron,
        items: [
          {
            key: "showDesktopLyric",
            label: t("setting.lyrics.show_desktop_lyrics"),
            type: "switch",
            value: computed({
              get: () => statusStore.showDesktopLyric,
              set: (v) => player.setDesktopLyricShow(v),
            }),
          },
          {
            key: "desktopLyricLock",
            label: t("setting.lyrics.desktop_lyrics_lock"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_lock_tip"),
            value: computed({
              get: () => desktopLyricConfig.isLock,
              set: (v) => {
                desktopLyricConfig.isLock = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricDoubleLine",
            label: t("setting.lyrics.desktop_lyrics_double_line"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_double_line_tip"),
            value: computed({
              get: () => desktopLyricConfig.isDoubleLine,
              set: (v) => {
                desktopLyricConfig.isDoubleLine = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricLimitBounds",
            label: t("setting.lyrics.desktop_lyrics_limit_bounds"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_limit_bounds_tip"),
            value: computed({
              get: () => desktopLyricConfig.limitBounds,
              set: (v) => {
                desktopLyricConfig.limitBounds = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricPosition",
            label: t("setting.lyrics.desktop_lyrics_align"),
            type: "select",
            description: t("setting.lyrics.desktop_lyrics_align_tip"),
            options: [
              { label: t("setting.lyrics.desktop_lyrics_align_value_left"), value: "left" },
              { label: t("setting.lyrics.desktop_lyrics_align_value_center"), value: "center" },
              { label: t("setting.lyrics.desktop_lyrics_align_value_right"), value: "right" },
              { label: t("setting.lyrics.desktop_lyrics_align_value_both"), value: "both" },
            ],
            value: computed({
              get: () => desktopLyricConfig.position,
              set: (v) => {
                desktopLyricConfig.position = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricFont",
            label: t("setting.lyrics.desktop_lyrics_font_family"),
            type: "button",
            description: t("setting.lyrics.desktop_lyrics_font_family_tip"),
            buttonLabel: t("common.configuration"),
            action: openFontManager,
          },
          {
            key: "desktopLyricShowYrc",
            label: t("setting.lyrics.show_desktop_font_lyrics"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_font_lyrics"),
            value: computed({
              get: () => desktopLyricConfig.showYrc,
              set: (v) => {
                desktopLyricConfig.showYrc = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricShowTran",
            label: t("setting.lyrics.show_desktop_lyrics_trans"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_lyrics_trans_tip"),
            value: computed({
              get: () => desktopLyricConfig.showTran,
              set: (v) => {
                desktopLyricConfig.showTran = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricAnimation",
            label: t("setting.lyrics.show_desktop_animation"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_animation_tip"),
            value: computed({
              get: () => desktopLyricConfig.animation,
              set: (v) => {
                desktopLyricConfig.animation = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricFontSize",
            label: t("setting.lyrics.desktop_lyrics_font_size"),
            type: "select",
            description: t("setting.lyrics.desktop_lyrics_font_size_tip"),
            options: Array.from({ length: 96 - 20 + 1 }, (_, i) => ({
              label: `${20 + i} px`,
              value: 20 + i,
            })),
            value: computed({
              get: () => desktopLyricConfig.font.size,
              set: (v) => {
                desktopLyricConfig.font.size = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricPlayedColor",
            label: t("setting.lyrics.desktop_lyrics_font_color_played"),
            type: "color-picker",
            description: t("setting.lyrics.desktop_lyrics_font_color_played_tip"),
            componentProps: { showAlpha: false, modes: ["hex"] },
            value: computed({
              get: () => desktopLyricConfig.playedColor,
              set: (v) => (desktopLyricConfig.playedColor = v),
            }),
            action: saveDesktopLyricConfig,
          },
          {
            key: "desktopLyricUnplayedColor",
            label: t("setting.lyrics.desktop_lyrics_font_color_unplayed"),
            type: "color-picker",
            description: t("setting.lyrics.desktop_lyrics_font_color_unplayed_tip"),
            componentProps: { showAlpha: false, modes: ["hex"] },
            value: computed({
              get: () => desktopLyricConfig.unplayedColor,
              set: (v) => (desktopLyricConfig.unplayedColor = v),
            }),
            action: saveDesktopLyricConfig,
          },
          {
            key: "desktopLyricShadowColor",
            label: t("setting.lyrics.desktop_lyrics_shadow_color"),
            type: "color-picker",
            description: t("setting.lyrics.desktop_lyrics_shadow_color_tip"),
            componentProps: { showAlpha: true, modes: ["rgb"] },
            value: computed({
              get: () => desktopLyricConfig.shadowColor,
              set: (v) => (desktopLyricConfig.shadowColor = v),
            }),
            action: saveDesktopLyricConfig,
          },
          {
            key: "desktopLyricTextBackgroundMask",
            label: t("setting.lyrics.desktop_lyrics_text_background_mask"),
            type: "switch",
            value: computed({
              get: () => desktopLyricConfig.textBackgroundMask,
              set: (v) => {
                desktopLyricConfig.textBackgroundMask = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricAlwaysShowPlayInfo",
            label: t("setting.lyrics.desktop_lyrics_always_show_play_info"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_always_show_play_info_tip"),
            value: computed({
              get: () => desktopLyricConfig.alwaysShowPlayInfo,
              set: (v) => {
                desktopLyricConfig.alwaysShowPlayInfo = v;
                saveDesktopLyricConfig();
              },
            }),
          },
          {
            key: "desktopLyricResetPosition",
            label: t("setting.lyrics.desktop_lyrics_reset_position"),
            type: "button",
            description: t("setting.lyrics.desktop_lyrics_reset_position_tip"),
            buttonLabel: t("common.reset_position"),
            action: resetDesktopLyricWindow,
          },
          {
            key: "desktopLyricRestore",
            label: t("setting.lyrics.desktop_lyrics_reset_default"),
            type: "button",
            description: t("setting.lyrics.desktop_lyrics_reset_default_tip"),
            buttonLabel: t("common.reset_default"),
            action: restoreDesktopLyricConfig,
          },
        ],
      },
    ],
  };
};
