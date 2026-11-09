import { DropdownOption, NAlert } from "naive-ui";
import { useStatusStore, useDataStore, usePlatformStore, useMusicStore } from "@/stores";
import { renderIcon, copyData, getShareUrl } from "@/utils/helper";
import {
  openDownloadSong,
  openJumpArtist,
  openPlaylistAdd,
  openSongInfoEditor,
} from "@/utils/modal";
import { deleteSongs, isLogin } from "@/utils/auth";
import { FeatureSupportFlag } from "@/api/platform";
import { buildSourceUrl } from "@/api/source";
import { useI18n } from "vue-i18n";
import type { SongInfo } from "@/types/main.hemusic";
import { songEqual } from "@/utils/song";
import { usePlayer } from "@/utils/player";
import songManager from "@/utils/songManager";
import { getSizeCover } from "@/utils/format";
import { isMygo } from "@/utils/env";
import { filesSession } from "@/platform/filesSession";
import { nativeLocalEntry, localFilesSession } from "@/platform/localFilesSession";
import { LocalFileActions } from "@/platform/localFileActions";
import { mygoSongDownload } from "./mygoSongDownload";

/** 歌曲菜单 */
export const useSongMenu = () => {
  const router = useRouter();
  const dataStore = useDataStore();
  const statusStore = useStatusStore();
  const platformStore = usePlatformStore();
  const musicStore = useMusicStore();
  const player = usePlayer();
  const { t } = useI18n();

  const localFileActions = new LocalFileActions({
    access(song) {
      const owner = filesSession.value;
      const local = localFilesSession.value;
      const entry = nativeLocalEntry(song.id);
      if (
        !owner ||
        !local ||
        !entry ||
        song.platform !== "local" ||
        entry.relativePath !== song.path
      )
        return;
      const access = owner.fileActionAccess(entry.ref);
      if (!access) return;
      return {
        ...access,
        current: () =>
          filesSession.value === owner &&
          localFilesSession.value === local &&
          nativeLocalEntry(song.id) === entry &&
          access.current(),
      };
    },
    isPlaying: (song) => songEqual(musicStore.playSong, song),
    onRemoved() {
      void localFilesSession.value?.refreshAfterWrite().catch((error: unknown) => {
        console.error("文件已删除，但本地列表刷新失败", error);
      });
    },
  });
  const openSheetMusic = (song: SongInfo) => {
    if (
      song.path ||
      !platformStore.isFeatureSupport(
        song.platform,
        FeatureSupportFlag.FeatureSupportListSheetMusic,
      )
    ) {
      return;
    }
    statusStore.showFullPlayer = false;
    router.push({
      name: "song-sheet-music",
      query: { platform: song.platform, song_id: song.id, song_name: song.name },
    });
  };

  const deleteLocalSong = (
    song: SongInfo,
    emit: (event: "removeSong", args: SongInfo[]) => void,
  ) => {
    if (!song.path) return;
    window.$dialog.warning({
      title: t("common.confirm_delete"),
      content: () =>
        h("div", { style: { marginTop: "20px" } }, [
          h(NAlert, { showIcon: false }, { default: () => song.path }),
          h("div", { style: { marginTop: "20px" } }, [
            t("menu.delete_file_confirm"),
            h("strong", null, song.name),
            t("menu.delete_file_confirm_tip"),
          ]),
        ]),
      positiveText: t("common.delete"),
      negativeText: t("common.cancel"),
      onPositiveClick: async () => {
        const result = await localFileActions.remove(song);
        if (result.removed && !result.current) return;
        if (result.removed) {
          // 通知父组件删除歌曲
          emit("removeSong", [song]);
          const currentPlayList = dataStore.playList;
          const songToRemoveIndex = currentPlayList.findIndex((playSong) =>
            songEqual(playSong, song),
          );
          if (songToRemoveIndex !== -1) {
            player.removeSongIndex(songToRemoveIndex);
          }

          window.$message.success(`${song.name} ${t("menu.delete_file_success")}`);
        } else {
          window.$message.error(`${song.name} ${t("menu.delete_file_fail_and_retry")}`);
        }
      },
    });
  };

  // 生成菜单选项
  const getMenuOptions = (
    song: SongInfo,
    index: number,
    playlist: {
      id: string;
      platform?: string;
      type?: string;
    } = {
      id: "",
      platform: "",
      type: "",
    },
    emit: (event: "removeSong", args: SongInfo[]) => void,
  ): DropdownOption[] => {
    const isHasMv = !!song?.mv_id && song.mv_id !== "0";
    const isLocal = !!song?.path;
    const isLoginNormal = isLogin();
    // 是否当前播放
    const isCurrent = statusStore.playIndex === index;
    // 是否为用户歌单
    const isUserPlaylist = !!(playlist?.id && playlist?.type === "user-playlist");
    const nativeDownload = isMygo ? mygoSongDownload(filesSession, song) : undefined;
    const isDownloading = !!nativeDownload && !nativeDownload.task.done;

    return [
      {
        key: "play",
        label: t("menu.play"),
        props: {
          onClick: () => player.addNextSong(song, true),
        },
        icon: renderIcon("Play", { size: 18 }),
      },
      {
        key: "play-next",
        label: t("menu.play_next"),
        show: !isCurrent && !statusStore.radioMode,
        props: {
          onClick: () => player.addNextSong(song, false),
        },
        icon: renderIcon("PlayNext", { size: 18 }),
      },
      {
        key: "playlist-add",
        label: t("menu.add_to_playlist"),
        show: !isLocal,
        props: {
          onClick: () => openPlaylistAdd([song], isLocal),
        },
        icon: renderIcon("AddList", { size: 18 }),
      },
      {
        key: "mv",
        label: t("menu.watch_mv"),
        show: isHasMv,
        props: {
          onClick: () =>
            router.push({ name: "video", query: { id: song.mv_id, platform: song.platform } }),
        },
        icon: renderIcon("Video", { size: 18 }),
      },
      {
        key: "detail",
        label: t("common.view_detail"),
        show:
          !isLocal &&
          platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.GetSongDetail),
        props: {
          onClick: () =>
            router.push({ name: "song", query: { id: song.id, platform: song.platform } }),
        },
        icon: renderIcon("Eye", { size: 18 }),
      },
      {
        key: "sheet-music",
        label: t("sheet_music.view"),
        show:
          !isLocal &&
          platformStore.isFeatureSupport(
            song.platform,
            FeatureSupportFlag.FeatureSupportListSheetMusic,
          ),
        props: { onClick: () => openSheetMusic(song) },
        icon: renderIcon("Music", { size: 18 }),
      },
      {
        key: "comment",
        label: t("menu.view_comment"),
        show: platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.GetCommentList),
        props: {
          onClick: () => {
            statusStore.commentConfig = {
              id: song.id,
              name: song.name,
              creator: Array.isArray(song.artists)
                ? song.artists.map((item) => item.name).join(" / ")
                : String(song.artists),
              platform: song.platform,
              cover: getSizeCover(song, 300),
              resource_type: "song",
            };
            router.push({ name: "comment" });
          },
        },
        icon: renderIcon("Message", { size: 18 }),
      },
      {
        key: "line-1",
        type: "divider",
      },
      {
        key: "more",
        label: t("menu.more_operation"),
        icon: renderIcon("Menu", { size: 18 }),
        children: [
          {
            key: "code-name",
            label: t("menu.copy_song_name"),
            props: {
              onClick: () => copyData(song.name),
            },
            icon: renderIcon("Copy", { size: 18 }),
          },
          {
            key: "code-id",
            label: t("menu.copy_song_id"),
            show: !isLocal,
            props: {
              onClick: () => copyData(song.id),
            },
            icon: renderIcon("Copy", { size: 18 }),
          },
          {
            key: "share",
            label: t("menu.copy_share_link"),
            show: !isLocal,
            props: {
              onClick: async () => {
                const url = getShareUrl("song", song.id, song.platform);
                await copyData(url, t("menu.share_link_copied"));
              },
            },
            icon: renderIcon("Share", { size: 18 }),
          },
          {
            key: "source",
            label: t("common.open_source_page"),
            show:
              !isLocal &&
              platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.BuildSourceUrl),
            props: {
              onClick: async () => {
                const { url } = await buildSourceUrl(song.platform, song.id, "song");
                window.open(url);
              },
            },
            icon: renderIcon("Link", { size: 18 }),
          },
          {
            key: "line-2",
            type: "divider",
            show: isLocal,
          },
          {
            key: "meta-edit",
            label: t("menu.music_tag_edit"),
            show: isLocal,
            props: {
              onClick: () => {
                if (song.path) openSongInfoEditor(song);
              },
            },
            icon: renderIcon("EditNote", { size: 20 }),
          },
          {
            key: "line-1-1",
            type: "divider",
          },
          {
            key: "source",
            label: platformStore.getPlatformInfo(song.platform)?.name || song.platform,

            show: !isLocal,
            disabled: true,
            icon: renderIcon("Source"),
          },
        ],
      },
      {
        key: "line-3",
        type: "divider",
      },
      {
        key: "delete",
        label: t("menu.delete_from_playlist"),
        show: isUserPlaylist && isLoginNormal,
        props: {
          onClick: () =>
            deleteSongs(playlist.id, [{ id: song.id, platform: song.platform }], () =>
              emit("removeSong", [song]),
            ),
        },
        icon: renderIcon("Delete"),
      },
      {
        key: "delete-file",
        label: t("menu.delete_file"),
        show: isLocal && isMygo && !songEqual(musicStore.playSong, song),
        props: {
          onClick: () => deleteLocalSong(song, emit),
        },
        icon: renderIcon("Delete"),
      },
      {
        key: "open-folder",
        label: t("menu.open_folder"),
        show: isLocal && isMygo,
        props: {
          onClick: async () => {
            if (isMygo) {
              if (!(await localFileActions.reveal(song)))
                window.$message.error(t("message.local_file_action_failed"));
              return;
            }
          },
        },
        icon: renderIcon("SnippetFolder"),
      },
      {
        key: "search",
        label: t("menu.same_name_search"),
        props: {
          onClick: () => router.push({ name: "search", query: { keyword: song.name } }),
        },
        icon: renderIcon("Search"),
      },
      {
        key: "download",
        label: t("common.download_song"),
        show: !isLocal && !isDownloading,
        props: { onClick: () => openDownloadSong(song) },
        icon: renderIcon("Download"),
      },
      {
        key: "retry-download",
        label: t("download.retry"),
        show: isMygo ? !!nativeDownload?.task.retryable : isDownloading,
        props: {
          onClick: async () => {
            if (!nativeDownload) return;
            try {
              if (!(await nativeDownload.retry()) && nativeDownload.current())
                window.$message?.error(t("mygo.downloads.actionFailed"));
            } catch {
              if (nativeDownload.current())
                window.$message?.error(t("mygo.downloads.actionFailed"));
            }
          },
        },
        icon: renderIcon("Refresh"),
      },
    ];
  };

  // 生成菜单选项
  const getPlayerMenuOptions = (
    song: SongInfo,
    emit: (event: "clickQuality", args: any[]) => void,
  ): DropdownOption[] => {
    const isHasMv = !!song?.mv_id && song.mv_id !== "0";
    const albumId = (typeof song?.album == "object" && song?.album.id) || null;
    const { artist, album } = songManager.getPlayerInfoObj(song) || {};
    const isLocal = !!song?.path;
    const nativeDownload = isMygo ? mygoSongDownload(filesSession, song) : undefined;
    const isDownloading = !!nativeDownload && !nativeDownload.task.done;

    return [
      {
        key: "album",
        label: `${t("common.album")}：${album}`,
        props: {
          onClick: () => {
            if (!albumId || albumId === "0") {
              return;
            }
            router.push({ name: "album", query: { id: albumId, platform: song.platform } });
          },
        },
        icon: renderIcon("Album", { size: 18 }),
        hideFullPlayer: true,
      },
      {
        key: "artists",
        label: `${t("common.artists")}：${artist}`,
        props: {
          onClick: () => openJumpArtist(song.platform, song.artists),
        },
        icon: renderIcon("Artist", { size: 18 }),
        hideFullPlayer: true,
      },
      {
        key: "quality",
        label: `${t("common.song_quality")}：${statusStore.playQuality}`,
        props: {
          onClick: () => !isLocal && emit("clickQuality", []),
        },
        icon: renderIcon("Eq", { size: 18 }),
      },
      {
        key: "mv",
        label: t("menu.watch_mv"),
        show: isHasMv,
        props: {
          onClick: () =>
            router.push({ name: "video", query: { id: song.mv_id, platform: song.platform } }),
        },
        icon: renderIcon("Video", { size: 18 }),
        hideFullPlayer: true,
      },
      {
        key: "detail",
        label: t("common.view_detail"),
        show:
          !isLocal && platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.GetSongInfo),
        props: {
          onClick: () => {
            statusStore.showFullPlayer = false;
            router.push({ name: "song", query: { id: song.id, platform: song.platform } });
          },
        },
        icon: renderIcon("Eye", { size: 18 }),
        hideFullPlayer: true,
      },
      {
        key: "sheet-music",
        label: t("sheet_music.view"),
        show:
          !isLocal &&
          platformStore.isFeatureSupport(
            song.platform,
            FeatureSupportFlag.FeatureSupportListSheetMusic,
          ),
        props: { onClick: () => openSheetMusic(song) },
        icon: renderIcon("Music", { size: 18 }),
      },
      {
        key: "comment",
        label: t("menu.view_comment"),
        show: platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.GetCommentList),
        props: {
          onClick: () => {
            statusStore.commentConfig = {
              id: song.id,
              name: song.name,
              creator: Array.isArray(song.artists)
                ? song.artists.map((item) => item.name).join(" / ")
                : String(song.artists),
              platform: song.platform,
              cover: getSizeCover(song, 300),
              resource_type: "song",
            };
            statusStore.showFullPlayer = false;
            router.push({ name: "comment" });
          },
        },
        icon: renderIcon("Message", { size: 18 }),
      },
      {
        key: "line-1",
        type: "divider",
      },
      {
        key: "search",
        label: t("menu.same_name_search"),
        props: {
          onClick: () => router.push({ name: "search", query: { keyword: song.name } }),
        },
        icon: renderIcon("Search"),
        hideFullPlayer: true,
      },
      {
        key: "download",
        label: t("common.download_song"),
        show: !isLocal && !isDownloading,
        props: { onClick: () => openDownloadSong(song) },
        icon: renderIcon("Download"),
      },
      {
        key: "code-name",
        label: t("menu.copy_song_name"),
        props: {
          onClick: () => copyData(song.name),
        },
        icon: renderIcon("Copy", { size: 18 }),
      },
      {
        key: "code-id",
        label: t("menu.copy_song_id"),
        show: !isLocal,
        props: {
          onClick: () => copyData(song.id),
        },
        icon: renderIcon("Copy", { size: 18 }),
      },
      {
        key: "share",
        label: t("menu.copy_share_link"),
        show: !isLocal,
        props: {
          onClick: async () => {
            const url = getShareUrl("song", song.id, song.platform);
            await copyData(url, t("menu.share_link_copied"));
          },
        },
        icon: renderIcon("Share", { size: 18 }),
      },
      {
        key: "source",
        label: t("common.open_source_page"),
        show:
          !isLocal &&
          platformStore.isFeatureSupport(song.platform, FeatureSupportFlag.BuildSourceUrl),
        props: {
          onClick: async () => {
            const { url } = await buildSourceUrl(song.platform, song.id, "song");
            window.open(url);
          },
        },
        icon: renderIcon("Link", { size: 18 }),
      },
      {
        key: "platform",
        label: platformStore.getPlatformInfo(song.platform)?.name || song.platform,

        show: !isLocal,
        disabled: true,
        icon: renderIcon("Source"),
      },
    ];
  };

  const getQualityMenuOptions = (song: SongInfo): DropdownOption[] => {
    if (song.path) {
      return [
        {
          label: song?.quality,
          key: song?.quality,
          props: {
            onClick: () => {},
          },
        },
      ];
    }
    return song?.links?.map((item): DropdownOption => {
      const desc = platformStore.getPlatformQualityDescription(song?.platform, item.name);
      return {
        label: desc ? `${item.name}(${desc})` : `${item.name}`,
        key: item.name,
        props: {
          onClick: () => {
            player.changeQuality(item.name);
          },
        },
      };
    });
  };
  return { getMenuOptions, getPlayerMenuOptions, getQualityMenuOptions };
};
