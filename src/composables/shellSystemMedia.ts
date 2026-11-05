import { useDataStore, useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { platform } from "@/platform";
import { usePlayer } from "@/utils/player";
import { SystemMediaSession } from "@/platform/systemMediaSession";
import { createWebKitSystemMedia } from "@/platform/systemMediaWebKit";
import { nativeLocalEntry } from "@/platform/localFilesSession";

export function createShellSystemMediaSession(): SystemMediaSession | undefined {
  const native = platform.systemMedia;
  if (!native) return;
  const provider =
    platform.kind === "mygo" && platform.os === "darwin" ? createWebKitSystemMedia(native) : native;
  const music = useMusicStore();
  const status = useStatusStore();
  const setting = useSettingStore();
  const data = useDataStore();
  const player = usePlayer();
  const trackID = () => {
    const song = music.playSong;
    return song?.id && song.platform && (!song.path || nativeLocalEntry(song.id))
      ? JSON.stringify([song.platform, song.id])
      : null;
  };
  return new SystemMediaSession(
    provider,
    {
      settings: () => ({ media: setting.smtcOpen, preventSleep: setting.preventSleep }),
      trackID,
      artwork: () => (trackID() && music.playSong.name?.trim() ? music.getSongCover(512) : null),
      metadata: () => {
        const id = trackID();
        const song = music.playSong;
        if (!id || !song.name?.trim()) return null;
        const duration = status.duration;
        const canChange = status.radioMode || data.playList.length > 0;
        return {
          id,
          source: "online",
          title: song.name,
          artist: Array.isArray(song.artists)
            ? song.artists.map((artist) => artist.name).join(" / ")
            : (song.artists ?? ""),
          album: typeof song.album === "object" ? song.album.name : song.album,
          durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
          rate: status.playRate,
          canPrevious: canChange,
          canNext: canChange,
        };
      },
      state: () => (status.playStatus ? "playing" : "paused"),
      playback: () => {
        const position = player.getSeek();
        const duration = status.duration;
        return {
          state: status.playStatus ? "playing" : "paused",
          positionMs: Number.isFinite(position)
            ? Math.max(0, duration > 0 ? Math.min(position, duration) : position)
            : 0,
        };
      },
      onSeek: (listener) => player.onSeek(listener),
      execute: async (command) => {
        if (command.trackId !== trackID()) return;
        if (command.action === "play") await player.play();
        else if (command.action === "pause") await player.pause();
        else if (command.action === "previous") await player.nextOrPrev("prev");
        else if (command.action === "next") await player.nextOrPrev("next");
        else if (
          command.action === "seek" &&
          Number.isFinite(command.positionMs) &&
          command.positionMs >= 0
        ) {
          player.setSeek(command.positionMs);
        }
      },
    },
    (error: unknown) => console.error("系统媒体操作失败", error),
  );
}
