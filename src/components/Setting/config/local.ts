import { useSettingStore } from "@/stores";
import { SettingConfig } from "@/types/settings";
import { computed } from "vue";
import { t } from "@/i18n";
import { openLocalMusicDirectoryModal } from "@/utils/modal";

export const useLocalSettings = (): SettingConfig => {
  // const statusStore = useStatusStore();
  const settingStore = useSettingStore();

  const fileNameFormatOptions = [
    {
      label: t("setting.local.download_file_naming_format_title"),
      value: "title",
    },
    {
      label: t("setting.local.download_file_naming_format_artist_title"),
      value: "artist-title",
    },
    {
      label: t("setting.local.download_file_naming_format_title_artist"),
      value: "title-artist",
    },
  ];

  const folderStrategyOptions = [
    {
      label: t("common.none"),
      value: "none",
    },
    {
      label: t("common.artist"),
      value: "artist",
    },
    {
      label: `${t("common.artist")}/${t("common.album")}`,
      value: "artist-album",
    },
  ];

  // 更改下载目录
  const chooseDownloadPath = async () => {
    const path = await window.electron.ipcRenderer.invoke("choose-path");
    if (path) settingStore.downloadPath = path;
  };

  return {
    groups: [
      {
        title: t("setting.local.local_music"),
        items: [
          {
            key: "showLocalCover",
            label: t("setting.local.show_local_cover"),
            type: "switch",
            description: t("setting.local.show_local_cover_tip"),
            value: computed({
              get: () => settingStore.showLocalCover,
              set: (v) => (settingStore.showLocalCover = v),
            }),
          },
          // {
          //   key: "localFolderDisplayMode",
          //   label: "本地文件夹显示模式",
          //   type: "select",
          //   description: "选择本地音乐页面文件夹的显示方式",
          //   options: [
          //     { label: "标签页模式", value: "tab" },
          //     { label: "下拉筛选模式", value: "dropdown" },
          //   ],
          //   value: computed({
          //     get: () => settingStore.localFolderDisplayMode,
          //     set: (v) => (settingStore.localFolderDisplayMode = v),
          //   }),
          // },
          {
            key: "showDefaultLocalPath",
            label: t("setting.local.show_default_local_path"),
            type: "switch",
            value: computed({
              get: () => settingStore.showDefaultLocalPath,
              set: (v) => (settingStore.showDefaultLocalPath = v),
            }),
          },
          {
            key: "localFilesPath",
            label: t("setting.local.local_files_path"),
            type: "button",
            buttonLabel: t("local.manage_local_music_folder"),
            description: t("setting.local.local_files_path_tip"),
            action: openLocalMusicDirectoryModal,
          },
        ],
      },
      {
        title: t("setting.local.download_config"),
        items: [
          {
            key: "downloadPath",
            label: t("setting.local.default_download_path"),
            type: "button",
            description: computed(
              () => settingStore.downloadPath || t("setting.local.default_download_path_empty"),
            ),
            buttonLabel: t("common.change"),
            action: chooseDownloadPath,
            extraButton: {
              label: t("common.clear_select"),
              type: "primary",
              secondary: true,
              strong: true,
              action: () => (settingStore.downloadPath = ""),
              show: computed(() => !!settingStore.downloadPath),
            },
          },
          {
            key: "downloadMeta",
            label: t("setting.local.download_song_meta"),
            type: "switch",
            description: t("setting.local.download_song_meta_tip"),
            value: computed({
              get: () => settingStore.downloadMeta,
              set: (v) => (settingStore.downloadMeta = v),
            }),
          },
          {
            key: "downloadCover",
            label: t("setting.local.download_song_cover"),
            type: "switch",
            description: t("setting.local.download_song_cover_tip"),
            disabled: computed(() => !settingStore.downloadMeta),
            value: computed({
              get: () => settingStore.downloadCover,
              set: (v) => (settingStore.downloadCover = v),
            }),
          },
          {
            key: "downloadLyric",
            label: t("setting.local.download_song_lyric"),
            type: "switch",
            description: t("setting.local.download_song_lyric_tip"),
            disabled: computed(() => !settingStore.downloadMeta),
            value: computed({
              get: () => settingStore.downloadLyric,
              set: (v) => (settingStore.downloadLyric = v),
            }),
          },
          {
            key: "downloadLyricTranslation",
            label: t("setting.local.download_song_lyric_trans"),
            type: "switch",
            description: t("setting.local.download_song_lyric_trans_tip"),
            disabled: computed(() => !settingStore.downloadMeta || !settingStore.downloadLyric),
            value: computed({
              get: () => settingStore.downloadLyricTran,
              set: (v) => (settingStore.downloadLyricTran = v),
            }),
          },
          {
            key: "downloadLyricRomaji",
            label: t("setting.local.download_song_lyric_roma"),
            type: "switch",
            description: t("setting.local.download_song_lyric_roma_tip"),
            disabled: computed(() => !settingStore.downloadMeta || !settingStore.downloadLyric),
            value: computed({
              get: () => settingStore.downloadLyricRoma,
              set: (v) => (settingStore.downloadLyricRoma = v),
            }),
          },
          {
            key: "fileNameFormat",
            label: t("setting.local.file_naming_format"),
            type: "select",
            description: t("setting.local.file_naming_format_tip"),
            options: fileNameFormatOptions,
            value: computed({
              get: () => settingStore.fileNameFormat,
              set: (v) => (settingStore.fileNameFormat = v),
            }),
          },
          {
            key: "folderStrategy",
            label: t("setting.local.folder_strategy"),
            type: "select",
            description: t("setting.local.folder_strategy_tip"),
            options: folderStrategyOptions,
            value: computed({
              get: () => settingStore.folderStrategy,
              set: (v) => (settingStore.folderStrategy = v),
            }),
          },
          {
            key: "saveMetaFile",
            label: t("setting.local.save_song_meta_file"),
            type: "switch",
            description: t("setting.local.save_song_meta_file_tip"),
            disabled: computed(() => !settingStore.downloadMeta),
            value: computed({
              get: () => settingStore.saveMetaFile,
              set: (v) => (settingStore.saveMetaFile = v),
            }),
          },
        ],
      },
    ],
  };
};
