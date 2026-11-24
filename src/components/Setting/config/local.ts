import { useSettingStore } from "@/stores";
import { SettingConfig } from "@/types/settings";
import { computed } from "vue";
import { t } from "@/i18n";
import { openLocalMusicDirectoryModal } from "@/utils/modal";
import { isMygo } from "@/utils/env";
import { createMygoDownloadSettings } from "./localDownloadSettings";
import { localFilesSession } from "@/platform/localFilesSession";
import { usePlayer } from "@/utils/player";

export const useLocalSettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  return {
    groups: isMygo
      ? [
          {
            title: t("setting.local.directory_manage"),
            items: [
              {
                key: "localFilesPath",
                label: t("setting.local.directory_manage"),
                type: "button",
                buttonLabel: t("setting.local.directory_manage"),
                action: openLocalMusicDirectoryModal,
              },
            ],
          },
          {
            title: t("setting.local.local_music"),
            items: [
              {
                key: "showDefaultLocalPath",
                label: t("setting.local.show_default_local_path"),
                type: "switch",
                value: computed({
                  get: () => settingStore.showDefaultLocalPath,
                  set: (value) => (settingStore.showDefaultLocalPath = value),
                }),
              },
              {
                key: "showLocalCover",
                label: t("setting.local.show_local_cover"),
                description: t("setting.local.show_local_cover_tip"),
                type: "switch",
                value: computed({
                  get: () => settingStore.showLocalCover,
                  set: (value) => (settingStore.showLocalCover = value),
                }),
              },
              {
                key: "localLyricPriority",
                label: t("setting.local.lyric_priority"),
                type: "select",
                options: [
                  { label: t("setting.local.lyric_priority_sidecar"), value: "sidecar" },
                  { label: t("setting.local.lyric_priority_embedded"), value: "embedded" },
                ],
                value: computed({
                  get: () => settingStore.localLyricPriority,
                  set: (value) => {
                    if (value !== "sidecar" && value !== "embedded") return;
                    if (value === settingStore.localLyricPriority) return;
                    settingStore.localLyricPriority = value;
                    void usePlayer().reloadLocalLyrics();
                  },
                }),
              },
            ],
          },
          ...createMygoDownloadSettings({
            scanLibrary: async () => {
              await localFilesSession.value?.scan();
            },
          }).groups,
        ]
      : [],
  };
};
