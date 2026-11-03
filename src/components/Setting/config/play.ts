import { useSettingStore, useStatusStore } from "@/stores";
import { isMygo } from "@/utils/env";
import { platform } from "@/platform";
import { renderOption } from "@/utils/helper";
import { SettingConfig } from "@/types/settings";
import { SelectOption } from "naive-ui";
import { uniqBy } from "lodash-es";

import { readOutputDevices } from "@/utils/audioOutputDevices";
import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import { usePlayer } from "@/utils/player";
import { t } from "@/i18n";

export const usePlaySettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const statusStore = useStatusStore();
  const player = usePlayer();
  const isDesktop = isMygo;

  const canRequestOutputAccess = isMygo && platform.os === "darwin";
  const outputDevices = ref<SelectOption[]>([{ label: t("common.system_default"), value: "" }]);
  const readingOutputs = ref(false);
  let active = true;
  let revision = 0;
  const onDeactivate = () => {
    active = false;
    revision++;
  };
  if (getCurrentScope()) onScopeDispose(onDeactivate);

  // Passive enumeration never requests microphone access.
  const getOutputDevices = async (requestAccess = false) => {
    if (!isDesktop || !active || readingOutputs.value) return;
    const operation = ++revision;
    const current = () => active && revision === operation;
    readingOutputs.value = true;
    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices)
        throw new DOMException("Media devices unavailable", "NotSupportedError");
      const needsCapture =
        requestAccess && canRequestOutputAccess && !outputDevices.value.some((item) => item.value);
      const allDevices = await readOutputDevices(navigator.mediaDevices, needsCapture, current);
      if (!allDevices) return;
      const devices = uniqBy(
        allDevices.filter(
          (device) =>
            device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default",
        ),
        (device) => device.groupId || device.deviceId,
      );
      outputDevices.value = [
        { label: t("common.system_default"), value: "" },
        ...devices.map((device, index) => ({
          label: device.label || `${t("setting.play.output_device")} ${index + 1}`,
          value: device.deviceId,
        })),
      ];
      if (requestAccess && devices.length === 0)
        window.$message.warning(t("mygo.audio.output_devices_empty"));
    } catch (error) {
      if (!current()) return;
      console.error("获取 WebAudio 设备失败", error);
      if (requestAccess) {
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        window.$message.error(
          t(denied ? "mygo.audio.output_access_denied" : "mygo.audio.output_devices_failed"),
        );
      }
    } finally {
      readingOutputs.value = false;
    }
  };

  // 切换输出设备
  const playDeviceChange = async (deviceId: string) => {
    // 找到对应的 label 用于显示
    const option = outputDevices.value.find((d) => d.value === deviceId);
    const label = option?.label || deviceId;
    try {
      await player.toggleOutputDevice(deviceId);
      settingStore.playDevice = deviceId;
      window.$message.success(t("message.output_device_change_success", { device: label }));
    } catch (error) {
      console.error("Failed to change audio output device:", error);
      window.$message.error(t("message.output_device_change_failed"));
    }
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

  const onActivate = async () => {
    active = true;
    if (isDesktop) await getOutputDevices();
  };

  return {
    onActivate,
    onDeactivate,
    groups: [
      {
        title: t("setting.play.play_setting"),
        items: [
          {
            key: "autoPlay",
            label: t("setting.play.auto_play"),
            type: "switch",
            description: t("setting.play.auto_play_tip"),
            show: isDesktop,
            value: computed({
              get: () => settingStore.autoPlay,
              set: (v) => (settingStore.autoPlay = v),
            }),
            disabled: !isDesktop,
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
            show: !isMygo || Boolean(platform.systemMedia),
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
            show: isDesktop,
            description: t("setting.play.output_device_tip"),
            disabled: readingOutputs,
            extraButton: {
              label: t("mygo.audio.read_output_devices"),
              show: canRequestOutputAccess,
              action: () => void getOutputDevices(true),
            },
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
