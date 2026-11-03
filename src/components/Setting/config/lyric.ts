import { useSettingStore, useStatusStore } from "@/stores";
import { LyricConfig } from "@/types/desktop-lyric";
import { openExcludeLyric, openFontManager } from "@/utils/modal";
import { cloneDeep } from "lodash-es";
import defaultDesktopLyricConfig from "@/assets/data/lyricConfig";
import { SettingConfig } from "@/types/settings";
import LyricPreview from "../components/LyricPreview.vue";
import { t } from "@/i18n";
import { resolveKineticJumpGranularity } from "@/utils/lyric/kinetic";
import { usePlayer } from "@/utils/player";
import { platform } from "@/platform";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import { watch } from "vue";
import {
  createDefaultDesktopLyricStyle,
  parseDesktopLyricStyle,
} from "@/platform/desktopLyricStyle";
import {
  createDefaultDesktopLyricOptions,
  parseDesktopLyricOptions,
} from "@/platform/desktopLyricOptions";

export const useLyricSettings = (): SettingConfig => {
  const player = usePlayer();
  const statusStore = useStatusStore();
  const settingStore = useSettingStore();

  // 桌面歌词配置
  const desktopLyricConfig = reactive<LyricConfig>(cloneDeep(defaultDesktopLyricConfig));

  const nativeStyle = () =>
    parseDesktopLyricStyle(settingStore.desktopLyricStyle) ?? createDefaultDesktopLyricStyle();
  const syncNativeStyle = () => {
    if (platform.kind === "mygo") Object.assign(desktopLyricConfig, nativeStyle());
  };
  const syncNativeOptions = () => {
    if (platform.kind === "mygo") {
      Object.assign(
        desktopLyricConfig,
        parseDesktopLyricOptions(settingStore.desktopLyricOptions) ??
          createDefaultDesktopLyricOptions(),
      );
    }
  };
  watch(
    () =>
      platform.kind === "mygo"
        ? [
            settingStore.desktopLyricStyle?.playedColor,
            settingStore.desktopLyricStyle?.unplayedColor,
            settingStore.desktopLyricStyle?.shadowColor,
            settingStore.desktopLyricStyle?.textBackgroundMask,
          ]
        : [],
    syncNativeStyle,
    { immediate: true, flush: "sync" },
  );
  watch(
    () =>
      platform.kind === "mygo"
        ? [
            settingStore.desktopLyricOptions?.font?.family,
            settingStore.desktopLyricOptions?.font?.size,
            settingStore.desktopLyricOptions?.font?.weight,
            settingStore.desktopLyricOptions?.font?.postScriptName,
            settingStore.desktopLyricOptions?.font?.style,
            settingStore.desktopLyricOptions?.isDoubleLine,
            settingStore.desktopLyricOptions?.position,
            settingStore.desktopLyricOptions?.limitBounds,
            settingStore.desktopLyricOptions?.showYrc,
            settingStore.desktopLyricOptions?.showTran,
            settingStore.desktopLyricOptions?.animation,
            settingStore.desktopLyricOptions?.alwaysShowPlayInfo,
          ]
        : [],
    syncNativeOptions,
    { immediate: true, flush: "sync" },
  );
  const styleAvailable = computed(
    () => platform.kind === "mygo" && desktopLyricsSession.value?.ready.value === true,
  );

  // 保存桌面歌词配置
  const saveDesktopLyricConfig = () => {
    try {
      if (platform.kind === "mygo") {
        const style = parseDesktopLyricStyle({
          playedColor: desktopLyricConfig.playedColor,
          unplayedColor: desktopLyricConfig.unplayedColor,
          shadowColor: desktopLyricConfig.shadowColor,
          textBackgroundMask: desktopLyricConfig.textBackgroundMask,
        });
        if (!style) {
          syncNativeStyle();
          window.$message.error(t("message.desktop_lyrics_save_fail"));
          return;
        }
        settingStore.desktopLyricStyle = style;
        return;
      }
    } catch (error) {
      console.error("Failed to save options:", error);
      window.$message.error(t("message.desktop_lyrics_save_fail"));
      syncNativeStyle();
    }
  };
  const saveDesktopLyricOptions = () => {
    if (platform.kind !== "mygo") return saveDesktopLyricConfig();
    try {
      const options = parseDesktopLyricOptions({
        font: { ...desktopLyricConfig.font },
        isDoubleLine: desktopLyricConfig.isDoubleLine,
        position: desktopLyricConfig.position,
        limitBounds: desktopLyricConfig.limitBounds,
        showYrc: desktopLyricConfig.showYrc,
        showTran: desktopLyricConfig.showTran,
        animation: desktopLyricConfig.animation,
        alwaysShowPlayInfo: desktopLyricConfig.alwaysShowPlayInfo,
      });
      if (!options) {
        syncNativeOptions();
        window.$message.error(t("message.desktop_lyrics_save_fail"));
        return;
      }
      settingStore.desktopLyricOptions = options;
    } catch {
      syncNativeOptions();
      window.$message.error(t("message.desktop_lyrics_save_fail"));
    }
  };

  // 恢复默认桌面歌词配置
  const restoreDesktopLyricConfig = () => {
    try {
      if (platform.kind !== "mygo") return;
      window.$dialog.warning({
        title: t("common.warning"),
        content:
          platform.kind === "mygo"
            ? t("message.desktop_lyrics_style_reset_confirm")
            : t("message.desktop_lyrics_reset_confirm"),
        positiveText: t("common.ok"),
        negativeText: t("common.cancel"),
        onPositiveClick: () => {
          if (platform.kind === "mygo") {
            settingStore.desktopLyricStyle = createDefaultDesktopLyricStyle();
            return;
          }
        },
      });
    } catch (error) {
      console.error("Failed to save options:", error);
      window.$message.error(t("message.desktop_lyrics_reset_fail"));
      syncNativeStyle();
    }
  };

  // 重置桌面歌词位置
  const resetDesktopLyricWindow = () => {
    try {
      if (platform.kind === "mygo") {
        const session = desktopLyricsSession.value;
        if (!session?.ready.value || !session.canResetPosition) return;
        void session
          .requestResetPosition()
          .then(() => {
            if (desktopLyricsSession.value === session && session.ready.value) {
              window.$message.success(t("message.desktop_lyrics_position_reset_success"));
            }
          })
          .catch(() => {
            if (desktopLyricsSession.value === session && session.ready.value) {
              window.$message.error(t("message.desktop_lyrics_position_reset_fail"));
            }
          });
        return;
      }
    } catch (error) {
      console.error("Failed to reset desktop lyric window:", error);
      window.$message.error(t("message.desktop_lyrics_position_reset_fail"));
    }
  };

  return {
    groups: [
      {
        title: t("setting.lyrics.lyrics_setting"),
        items: [
          {
            key: "lyricRenderer",
            label: t("setting.lyrics.renderer"),
            type: "select",
            options: [
              { label: t("setting.lyrics.renderer_default"), value: "default" },
              { label: "AMLL", value: "amll" },
              { label: t("setting.lyrics.renderer_monet"), value: "monet" },
              { label: t("setting.lyrics.renderer_partita"), value: "partita" },
              { label: t("setting.lyrics.renderer_classic"), value: "classic" },
              { label: t("setting.lyrics.renderer_kinetic"), value: "kinetic" },
            ],
            value: computed({
              get: () => settingStore.lyricRenderer,
              set: (v) => (settingStore.lyricRenderer = v),
            }),
          },
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
              condition: () => settingStore.lyricRenderer === "amll",
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
              condition: () => settingStore.lyricRenderer === "amll",
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
              condition: () => settingStore.lyricRenderer === "amll",
              forcedValue: "flex-start",
            },
          },
          {
            key: "lyricsScrollOffset",
            label: t("setting.lyrics.lyrics_scroll_position"),
            type: "slider",
            description: t("setting.lyrics.lyrics_scroll_position_tip"),
            show: () => settingStore.lyricRenderer !== "partita",
            min: 0.1,
            max: 0.9,
            step: 0.05,
            marks: {
              0.1: t("setting.lyrics.lyrics_scroll_position_up"),
              0.9: t("setting.lyrics.lyrics_scroll_position_down"),
            },
            formatTooltip: (v) => `${(v * 100).toFixed(0)}%`,
            value: computed({
              get: () =>
                settingStore.lyricRenderer === "monet"
                  ? settingStore.monetScrollOffset
                  : settingStore.lyricsScrollOffset,
              set: (v) => {
                if (settingStore.lyricRenderer === "monet") settingStore.monetScrollOffset = v;
                else settingStore.lyricsScrollOffset = v;
              },
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
        title: t("setting.lyrics.renderer_default_settings"),
        show: () => settingStore.lyricRenderer === "default",
        items: [
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
            key: "lrcMousePause",
            label: t("setting.lyrics.lrc_mouse_pause"),
            type: "switch",
            description: t("setting.lyrics.lrc_mouse_pause_tip"),
            value: computed({
              get: () => settingStore.lrcMousePause,
              set: (v) => (settingStore.lrcMousePause = v),
            }),
          },
        ],
      },
      {
        title: "Apple Music-like Lyrics",
        tags: [{ text: "Beta", type: "warning" }],
        show: () => settingStore.lyricRenderer === "amll",
        items: [
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
      {
        title: t("setting.lyrics.monet_settings"),
        show: () => settingStore.lyricRenderer === "monet",
        items: [
          {
            key: "monetScrollOffset",
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
              get: () => settingStore.monetScrollOffset,
              set: (v) => (settingStore.monetScrollOffset = v),
            }),
          },
          {
            key: "showYrcAnimation",
            label: t("setting.lyrics.monet_word_animation"),
            type: "switch",
            show: () => settingStore.showYrc,
            value: computed({
              get: () => settingStore.showYrcAnimation,
              set: (v) => (settingStore.showYrcAnimation = v),
            }),
          },
          {
            key: "showYrcLongEffect",
            label: t("setting.lyrics.monet_long_word_effect"),
            type: "switch",
            show: () => settingStore.showYrc && settingStore.showYrcAnimation,
            value: computed({
              get: () => settingStore.showYrcLongEffect,
              set: (v) => (settingStore.showYrcLongEffect = v),
            }),
          },
          {
            key: "lrcMousePause",
            label: t("setting.lyrics.lrc_mouse_pause"),
            type: "switch",
            description: t("setting.lyrics.lrc_mouse_pause_tip"),
            value: computed({
              get: () => settingStore.lrcMousePause,
              set: (v) => (settingStore.lrcMousePause = v),
            }),
          },
        ],
      },
      {
        title: t("setting.lyrics.partita_settings"),
        show: () => settingStore.lyricRenderer === "partita",
        items: [
          {
            key: "showPartitaGuideLines",
            label: t("setting.lyrics.partita_guide_lines"),
            type: "switch",
            description: t("setting.lyrics.partita_guide_lines_tip"),
            value: computed({
              get: () => settingStore.showPartitaGuideLines,
              set: (v) => (settingStore.showPartitaGuideLines = v),
            }),
          },
          {
            key: "showPartitaUpcoming",
            label: t("setting.lyrics.partita_upcoming"),
            type: "switch",
            description: t("setting.lyrics.partita_upcoming_tip"),
            value: computed({
              get: () => settingStore.showPartitaUpcoming,
              set: (v) => (settingStore.showPartitaUpcoming = v),
            }),
          },
          {
            key: "partitaStagger",
            label: t("setting.lyrics.partita_stagger"),
            type: "slider",
            description: t("setting.lyrics.partita_stagger_tip"),
            min: 12,
            max: 64,
            step: 4,
            formatTooltip: (v) => `${v}px`,
            value: computed({
              get: () => settingStore.partitaStagger,
              set: (v) => (settingStore.partitaStagger = v),
            }),
          },
          {
            key: "showYrcAnimation",
            label: t("setting.lyrics.monet_word_animation"),
            type: "switch",
            show: () => settingStore.showYrc,
            value: computed({
              get: () => settingStore.showYrcAnimation,
              set: (v) => (settingStore.showYrcAnimation = v),
            }),
          },
        ],
      },
      {
        title: t("setting.lyrics.kinetic_settings"),
        show: () => settingStore.lyricRenderer === "kinetic",
        items: [
          {
            key: "kineticJumpGranularity",
            label: t("setting.lyrics.kinetic_jump_granularity"),
            type: "select",
            description: t("setting.lyrics.kinetic_jump_granularity_tip"),
            options: [
              { label: t("setting.lyrics.kinetic_jump_auto"), value: "auto" },
              { label: t("setting.lyrics.kinetic_jump_character"), value: "character" },
              { label: t("setting.lyrics.kinetic_jump_word"), value: "word" },
            ],
            value: computed({
              get: () => settingStore.kineticJumpGranularity,
              set: (v) => (settingStore.kineticJumpGranularity = resolveKineticJumpGranularity(v)),
            }),
          },
        ],
      },
      {
        title: t("setting.lyrics.classic_settings"),
        show: () => settingStore.lyricRenderer === "classic",
        items: [
          {
            key: "classicWordRotation",
            label: t("setting.lyrics.classic_word_rotation"),
            type: "switch",
            description: t("setting.lyrics.classic_word_rotation_tip"),
            value: computed({
              get: () => settingStore.classicWordRotation,
              set: (v) => (settingStore.classicWordRotation = v),
            }),
          },
          {
            key: "classicBreathingFloat",
            label: t("setting.lyrics.classic_breathing_float"),
            type: "slider",
            description: t("setting.lyrics.classic_breathing_float_tip"),
            min: 0,
            max: 2,
            step: 0.1,
            marks: {
              0: t("common.close"),
              1: "1x",
              2: "2x",
            },
            formatTooltip: (v) => `${(v * 100).toFixed(0)}%`,
            value: computed({
              get: () => settingStore.classicBreathingFloat,
              set: (v) => (settingStore.classicBreathingFloat = v),
            }),
          },
          {
            key: "classicWordSpacing",
            label: t("setting.lyrics.classic_word_spacing"),
            type: "slider",
            description: t("setting.lyrics.classic_word_spacing_tip"),
            min: 0.3,
            max: 1.5,
            step: 0.05,
            formatTooltip: (v) => `${(v * 100).toFixed(0)}%`,
            value: computed({
              get: () => settingStore.classicWordSpacing,
              set: (v) => (settingStore.classicWordSpacing = v),
            }),
          },
          {
            key: "classicShowUpcoming",
            label: t("setting.lyrics.classic_upcoming"),
            type: "switch",
            description: t("setting.lyrics.classic_upcoming_tip"),
            value: computed({
              get: () => settingStore.classicShowUpcoming,
              set: (v) => (settingStore.classicShowUpcoming = v),
            }),
          },
          {
            key: "showYrcAnimation",
            label: t("setting.lyrics.monet_word_animation"),
            type: "switch",
            show: () => settingStore.showYrc,
            value: computed({
              get: () => settingStore.showYrcAnimation,
              set: (v) => (settingStore.showYrcAnimation = v),
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
        title: t("common.desktop_lyrics"),
        tags: [{ text: "Beta", type: "warning" }],
        show: () => platform.capabilities.desktopLyrics,
        items: [
          {
            key: "showDesktopLyric",
            label: t("setting.lyrics.show_desktop_lyrics"),
            type: "switch",
            disabled: () =>
              !desktopLyricsSession.value?.ready.value ||
              desktopLyricsSession.value?.window.value?.pending === true,
            value: computed({
              get: () => statusStore.showDesktopLyric,
              set: (v) => player.setDesktopLyricShow(v),
            }),
          },
          {
            key: "desktopLyricLock",
            show: () => platform.capabilities.desktopLyrics,
            disabled: () => {
              const session = desktopLyricsSession.value;
              const state = session?.window.value;
              return (
                !session?.ready.value ||
                (!state?.locked &&
                  (!state?.visible || state.pending || !platform.capabilities.tray))
              );
            },
            label: t("setting.lyrics.desktop_lyrics_lock"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_lock_tip"),
            value: computed({
              get: () => desktopLyricsSession.value?.window.value?.locked ?? false,
              set: (v) => {
                const session = desktopLyricsSession.value;
                if (session?.ready.value) {
                  void session.requestLocked(v).catch(() => {
                    if (desktopLyricsSession.value !== session || !session.ready.value) return;
                    window.$message?.error(t("message.desktop_lyrics_operation_failed"));
                  });
                }
              },
            }),
          },
          {
            key: "desktopLyricDoubleLine",
            show: styleAvailable,
            label: t("setting.lyrics.desktop_lyrics_double_line"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_double_line_tip"),
            value: computed({
              get: () => desktopLyricConfig.isDoubleLine,
              set: (v) => {
                desktopLyricConfig.isDoubleLine = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricLimitBounds",
            show: styleAvailable,
            label: t("setting.lyrics.desktop_lyrics_limit_bounds"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_limit_bounds_tip"),
            value: computed({
              get: () => desktopLyricConfig.limitBounds,
              set: (v) => {
                desktopLyricConfig.limitBounds = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricPosition",
            show: styleAvailable,
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
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricFont",
            show: () => platform.kind === "mygo" && styleAvailable.value,
            label: t("setting.lyrics.desktop_lyrics_font_family"),
            type: "button",
            description: t("setting.lyrics.desktop_lyrics_font_family_tip"),
            buttonLabel: t("common.configuration"),
            action: openFontManager,
          },
          {
            key: "desktopLyricFontWeight",
            show: () => platform.kind === "mygo" && styleAvailable.value,
            label: t("setting.lyrics.desktop_lyrics_font_weight"),
            type: "select",
            options: Array.from({ length: 9 }, (_, index) => ({
              label: String((index + 1) * 100),
              value: (index + 1) * 100,
            })),
            value: computed({
              get: () => desktopLyricConfig.font.weight,
              set: (value: number) => {
                desktopLyricConfig.font.weight = value;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricFontStyle",
            show: () => platform.kind === "mygo" && styleAvailable.value,
            label: t("setting.lyrics.desktop_lyrics_font_style"),
            type: "select",
            options: ["normal", "italic", "oblique"].map((value) => ({
              label: t(`setting.lyrics.desktop_lyrics_font_style_${value}`),
              value,
            })),
            value: computed({
              get: () => desktopLyricConfig.font.style,
              set: (value: string) => {
                desktopLyricConfig.font.style = value;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricShowYrc",
            show: styleAvailable,
            label: t("setting.lyrics.show_desktop_font_lyrics"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_font_lyrics"),
            value: computed({
              get: () => desktopLyricConfig.showYrc,
              set: (v) => {
                desktopLyricConfig.showYrc = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricShowTran",
            show: styleAvailable,
            label: t("setting.lyrics.show_desktop_lyrics_trans"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_lyrics_trans_tip"),
            value: computed({
              get: () => desktopLyricConfig.showTran,
              set: (v) => {
                desktopLyricConfig.showTran = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricAnimation",
            show: styleAvailable,
            label: t("setting.lyrics.show_desktop_animation"),
            type: "switch",
            description: t("setting.lyrics.show_desktop_animation_tip"),
            value: computed({
              get: () => desktopLyricConfig.animation,
              set: (v) => {
                desktopLyricConfig.animation = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricFontSize",
            show: styleAvailable,
            disabled: () =>
              platform.kind === "mygo" && desktopLyricsSession.value?.window.value?.locked === true,
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
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricPlayedColor",
            show: styleAvailable,
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
            show: styleAvailable,
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
            show: styleAvailable,
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
            show: styleAvailable,
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
            show: styleAvailable,
            label: t("setting.lyrics.desktop_lyrics_always_show_play_info"),
            type: "switch",
            description: t("setting.lyrics.desktop_lyrics_always_show_play_info_tip"),
            value: computed({
              get: () => desktopLyricConfig.alwaysShowPlayInfo,
              set: (v) => {
                desktopLyricConfig.alwaysShowPlayInfo = v;
                saveDesktopLyricOptions();
              },
            }),
          },
          {
            key: "desktopLyricResetPosition",
            show: styleAvailable,
            disabled: () =>
              platform.kind === "mygo" &&
              (!desktopLyricsSession.value?.canResetPosition ||
                desktopLyricsSession.value.window.value?.locked === true ||
                desktopLyricsSession.value.window.value?.pending === true),
            label: t("setting.lyrics.desktop_lyrics_reset_position"),
            type: "button",
            description: t("setting.lyrics.desktop_lyrics_reset_position_tip"),
            buttonLabel: t("common.reset_position"),
            action: resetDesktopLyricWindow,
          },
          {
            key: "desktopLyricOptionsRestore",
            show: () => platform.kind === "mygo" && styleAvailable.value,
            label: t("setting.lyrics.desktop_lyrics_options_reset_default"),
            type: "button",
            buttonLabel: t("common.reset_default"),
            action: () =>
              window.$dialog.warning({
                title: t("common.warning"),
                content: t("message.desktop_lyrics_options_reset_confirm"),
                positiveText: t("common.ok"),
                negativeText: t("common.cancel"),
                onPositiveClick: () => {
                  settingStore.desktopLyricOptions = createDefaultDesktopLyricOptions();
                },
              }),
          },
          {
            key: "desktopLyricRestore",
            show: styleAvailable,
            label:
              platform.kind === "mygo"
                ? t("setting.lyrics.desktop_lyrics_style_reset_default")
                : t("setting.lyrics.desktop_lyrics_reset_default"),
            type: "button",
            description:
              platform.kind === "mygo"
                ? t("message.desktop_lyrics_style_reset_confirm")
                : t("setting.lyrics.desktop_lyrics_reset_default_tip"),
            buttonLabel: t("common.reset_default"),
            action: restoreDesktopLyricConfig,
          },
        ],
      },
    ],
  };
};
