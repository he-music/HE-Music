import { useSettingStore, useStatusStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { renderOption } from "@/utils/helper";
import { SettingConfig } from "@/types/settings";
import { SelectOption } from "naive-ui";
import { uniqBy } from "lodash-es";

import { computed, ref } from "vue";
import { usePlayer } from "@/utils/player";
import { t } from "@/i18n";

export const usePlaySettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const statusStore = useStatusStore();
  const player = usePlayer();

  const outputDevices = ref<SelectOption[]>([]);

  // 获取全部输出设备
  const getOutputDevices = async () => {
    if (!isElectron) return; // 简单处理：非 Electron 环境暂不复杂处理
    // WebAudio 引擎：使用浏览器设备列表
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const devices = uniqBy(
        allDevices.filter((device) => device.kind === "audiooutput" && device.deviceId),
        "groupId",
      );
      const outputData = devices.filter((device) => device.kind === "audiooutput");
      outputDevices.value = outputData.map((device) => ({
        label: device.label,
        value: device.deviceId,
      }));
    } catch (e) {
      console.error("获取 WebAudio 设备失败", e);
    }
  };

  // mpv 切换输出设备
  const playDeviceChange = async (deviceId: string) => {
    // 找到对应的 label 用于显示
    const option = outputDevices.value.find((d) => d.value === deviceId);
    const label = option?.label || deviceId;
    player.toggleOutputDevice(deviceId);
    window.$message.success(t("message.output_device_change_success", { device: label }));
  };
  // 音质数据
  const songLevelData = {
    auto: {
      label: t("common.auto"),
      tip: t("setting.play.song_quality_value_auto_tip", {
        quality: statusStore.selectedQuality,
        left: ["hires", "flac", "320mp3", "128mp3"]
          .filter((item) => item !== statusStore.selectedQuality)
          .join(">"),
      }),
      value: "auto",
    },
    "128mp3": {
      label: "128mp3",
      tip: t("setting.play.song_quality_value_128mp3_tip"),
      value: "128mp3",
    },
    "192mp3": {
      label: "192mp3",
      tip: t("setting.play.song_quality_value_192mp3_tip"),
      value: "192mp3",
    },
    "320mp3": {
      label: "320mp3",
      tip: t("setting.play.song_quality_value_320mp3_tip"),
      value: "320mp3",
    },
    flac: {
      label: "flac",
      tip: t("setting.play.song_quality_value_flac_tip"),
      value: "flac",
    },
    hires: {
      label: "hires",
      tip: t("setting.play.song_quality_value_hires_tip"),
      value: "hires",
    },
    dolby: {
      label: "dolby",
      tip: t("setting.play.song_quality_value_dolby_tip"),
      value: "dolby",
    },
    galaxy: {
      label: "galaxy",
      tip: t("setting.play.song_quality_value_galaxy_tip"),
      value: "galaxy",
    },
    master: {
      label: "master",
      tip: t("setting.play.song_quality_value_master_tip"),
      value: "master",
    },
    // jymaster: {
    //   label: "超清母带 Master",
    //   tip: "还原音频细节，192kHz/24bit",
    //   value: "jymaster",
    // },
    // sky: {
    //   label: "沉浸环绕声 Surround Audio",
    //   tip: "沉浸式体验，最高 5.1 声道",
    //   value: "sky",
    // },
  };

  const onActivate = () => {
    if (isElectron) getOutputDevices();
  };

  return {
    onActivate,
    groups: [
      {
        title: t("setting.play.play_setting"),
        items: [
          {
            key: "autoPlay",
            label: t("setting.play.auto_play"),
            type: "switch",
            description: t("setting.play.auto_play_tip"),
            show: isElectron,
            value: computed({
              get: () => settingStore.autoPlay,
              set: (v) => (settingStore.autoPlay = v),
            }),
            disabled: !isElectron,
          },
          {
            key: "memoryLastSeek",
            label: t("setting.play.memory_last_seek"),
            type: "switch",
            description: t("setting.play.memory_last_seek_tip"),
            value: computed({
              get: () => settingStore.memoryLastSeek,
              set: (v) => (settingStore.memoryLastSeek = v),
            }),
          },
          {
            key: "preventSleep",
            label: t("setting.general.prevent_sleep"),
            type: "switch",
            description: t("setting.general.prevent_sleep_tip"),
            value: computed({
              get: () => settingStore.preventSleep,
              set: (v) => (settingStore.preventSleep = v),
            }),
          },
          {
            key: "songVolumeFade",
            label: t("setting.play.song_volume_fade"),
            type: "switch",
            value: computed({
              get: () => settingStore.songVolumeFade,
              set: (v) => (settingStore.songVolumeFade = v),
            }),
            children: [
              {
                key: "songVolumeFadeTime",
                label: t("setting.play.song_volume_fade_time"),
                type: "input-number",
                description: t("setting.play.song_volume_fade_time_tip"),
                min: 200,
                max: 2000,
                suffix: "ms",
                value: computed({
                  get: () => settingStore.songVolumeFadeTime,
                  set: (v) => (settingStore.songVolumeFadeTime = v),
                }),
              },
            ],
          },
        ],
      },
      {
        title: t("setting.play.audio_setting"),
        items: [
          {
            key: "songLevel",
            label: t("setting.play.online_song_quality"),
            type: "select",
            description: () => songLevelData[settingStore.songLevel]?.tip,
            options: Object.values(songLevelData),
            componentProps: {
              renderOption,
            },
            value: computed({
              get: () => settingStore.songLevel,
              set: (v) => (settingStore.songLevel = v),
            }),
          },
          {
            key: "playDevice",
            label: t("setting.play.output_device"),
            type: "select",
            show: isElectron,
            description: t("setting.play.output_device_tip"),
            options: outputDevices,
            componentProps: {
              renderOption,
            },
            value: computed({
              get: () => settingStore.playDevice,
              set: (v) => playDeviceChange(v),
            }),
          },
        ],
      },
    ],
  };
};
