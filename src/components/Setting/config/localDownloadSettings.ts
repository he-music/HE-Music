import { computed } from "vue";
import { t } from "@/i18n";
import type { SettingConfig } from "@/types/settings";
import { useSettingStore } from "@/stores";
import { filesSession } from "@/platform/filesSession";

type LegacyBooleanKey =
  | "downloadMeta"
  | "downloadCover"
  | "downloadLyric"
  | "downloadLyricTran"
  | "downloadLyricRoma"
  | "saveMetaFile";

const legacyBooleanSettings: readonly [LegacyBooleanKey, string, string][] = [
  ["downloadMeta", "setting.local.download_song_meta", "setting.local.download_song_meta_tip"],
  ["downloadCover", "setting.local.download_song_cover", "setting.local.download_song_cover_tip"],
  ["downloadLyric", "setting.local.download_song_lyric", "setting.local.download_song_lyric_tip"],
  [
    "downloadLyricTran",
    "setting.local.download_song_lyric_trans",
    "setting.local.download_song_lyric_trans_tip",
  ],
  [
    "downloadLyricRoma",
    "setting.local.download_song_lyric_roma",
    "setting.local.download_song_lyric_roma_tip",
  ],
  ["saveMetaFile", "setting.local.save_song_meta_file", "setting.local.save_song_meta_file_tip"],
];

export interface MygoDownloadSettingsHooks {
  readonly scanLibrary?: () => Promise<void>;
}

/** MyGo download settings use the native grant picker; a displayed path never grants access. */
export function createMygoDownloadSettings(hooks: MygoDownloadSettingsHooks = {}): SettingConfig {
  const settings = useSettingStore();
  const choose = async () => {
    const owner = filesSession.value;
    if (!owner) return;
    const result = await owner.chooseDirectory();
    if (owner !== filesSession.value) return;
    if (result.status !== "completed") {
      if (result.status === "failed") window.$message.error(t("setting.local.directory_failed"));
      return;
    }
    if (result.value.status !== "selected" || !result.value.grant) return;
    settings.downloadPath = result.value.grant.displayPath;
    await hooks.scanLibrary?.();
  };
  return {
    groups: [
      {
        title: t("setting.local.download_config"),
        items: [
          {
            key: "downloadPath",
            label: t("setting.local.default_download_path"),
            type: "button",
            description: computed(
              () => settings.downloadPath || t("setting.local.default_download_path_empty"),
            ),
            buttonLabel: t("common.change"),
            action: choose,
            extraButton: {
              label: t("common.clear_select"),
              type: "primary",
              secondary: true,
              strong: true,
              action: () => {
                settings.downloadPath = "";
              },
              show: computed(() => !!settings.downloadPath),
            },
          },
          ...legacyBooleanSettings.map(([key, label, description]) => ({
            key,
            label: t(label),
            type: "switch" as const,
            description: t(description),
            disabled: computed(() =>
              key === "downloadCover" || key === "downloadLyric"
                ? !settings.downloadMeta
                : key === "downloadLyricTran" || key === "downloadLyricRoma"
                  ? !settings.downloadMeta || !settings.downloadLyric
                  : key === "saveMetaFile"
                    ? !settings.downloadMeta
                    : false,
            ),
            value: computed({
              get: () => settings[key],
              set: (value: boolean) => {
                settings[key] = value;
              },
            }),
          })),
          {
            key: "fileNameFormat",
            label: t("setting.local.file_naming_format"),
            type: "select" as const,
            description: t("setting.local.file_naming_format_tip"),
            options: [
              { label: t("setting.local.download_file_naming_format_title"), value: "title" },
              {
                label: t("setting.local.download_file_naming_format_artist_title"),
                value: "artist-title",
              },
              {
                label: t("setting.local.download_file_naming_format_title_artist"),
                value: "title-artist",
              },
            ],
            value: computed({
              get: () => settings.fileNameFormat,
              set: (value) => {
                settings.fileNameFormat = value;
              },
            }),
          },
          {
            key: "folderStrategy",
            label: t("setting.local.folder_strategy"),
            type: "select" as const,
            description: t("setting.local.folder_strategy_tip"),
            options: [
              { label: t("common.none"), value: "none" },
              { label: t("common.artist"), value: "artist" },
              { label: `${t("common.artist")}/${t("common.album")}`, value: "artist-album" },
            ],
            value: computed({
              get: () => settings.folderStrategy,
              set: (value) => {
                settings.folderStrategy = value;
              },
            }),
          },
        ],
      },
    ],
  };
}
