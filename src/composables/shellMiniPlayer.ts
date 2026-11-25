import { shallowRef } from "vue";
import { gatewayProxyUrl } from "@/platform/gateway";
import type { PlatformMiniPlayer } from "@/platform/miniPlayer";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { createMiniPlayerSession } from "@/platform/miniPlayerSession";
import type { MiniPlayerSnapshot } from "@/platform/mygo.bindings";
import { useDataStore, useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { toLikeSong } from "@/utils/auth";
import { usePlayer } from "@/utils/player";

export function createShellMiniPlayerSession(
  provider: PlatformMiniPlayer,
  appearance: () => Pick<MiniPlayerSnapshot, "language" | "theme">,
  report: (error: unknown) => void,
) {
  const data = useDataStore();
  const music = useMusicStore();
  const settings = useSettingStore();
  const status = useStatusStore();
  const player = usePlayer();
  const favoriting = shallowRef(false);

  return createMiniPlayerSession(
    provider,
    () => {
      const song = music.playSong;
      const hasSong = Boolean(
        song.id && song.platform && (!song.path || nativeLocalEntry(song.id)),
      );
      const favorite = hasSong && data.userLoginStatus && !song.path;
      return {
        ...appearance(),
        // 切换账号后，即使两次播放的是同一首歌，也不接受旧收藏命令。
        trackKey: hasSong ? JSON.stringify([data.identityRevision, song.platform, song.id]) : "",
        title: hasSong ? song.name : "",
        artist: hasSong
          ? Array.isArray(song.artists)
            ? song.artists.map((artist) => artist.name).join(" / ")
            : (song.artists ?? "")
          : "",
        artwork:
          hasSong && (!song.path || settings.showLocalCover)
            ? gatewayProxyUrl(music.getSongCover(300))
            : "",
        playing: hasSong && status.playStatus,
        canPrevious: hasSong && !status.radioMode && data.playList.length > 1,
        canNext: hasSong && (status.radioMode || data.playList.length > 1),
        favorite: favorite && data.isLikeSong(song),
        canFavorite: favorite && !favoriting.value,
      };
    },
    async (command) => {
      if (command.action === "toggle") await player.playOrPause();
      else if (command.action === "previous" || command.action === "next") {
        await player.nextOrPrev(command.action === "next" ? "next" : "prev");
      } else if (command.action === "favorite") {
        favoriting.value = true;
        try {
          await toLikeSong(music.playSong, command.favorite);
        } finally {
          favoriting.value = false;
        }
      }
    },
    report,
  );
}
