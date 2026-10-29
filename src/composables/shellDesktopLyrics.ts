import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { platform } from "@/platform";
import { usePlayer } from "@/utils/player";
import { DesktopLyricsSession } from "@/platform/desktopLyricsSession";
import {
  createDefaultDesktopLyricStyle,
  parseDesktopLyricStyle,
} from "@/platform/desktopLyricStyle";

import {
  createDefaultDesktopLyricOptions,
  parseDesktopLyricOptions,
} from "@/platform/desktopLyricOptions";
export function createShellDesktopLyricsSession(): DesktopLyricsSession | undefined {
  const provider = platform.kind === "mygo" ? platform.desktopLyrics : undefined;
  if (!provider) return;
  const music = useMusicStore();
  const status = useStatusStore();
  const setting = useSettingStore();
  const player = usePlayer();
  const trackKey = () => {
    const song = music.playSong;
    return song.id && song.platform ? JSON.stringify([song.platform, song.id]) : "";
  };
  const artistName = () => {
    const artists = music.playSong.artists;
    return Array.isArray(artists)
      ? artists.map((artist) => artist.name).join(" / ")
      : (artists ?? "");
  };
  const clock = () => ({
    trackKey: trackKey(),
    playing: status.playStatus,
    // getSeek already converts HTMLAudio seconds to milliseconds.
    positionMs: player.getSeek(),
    offsetMs: status.getSongOffset(music.playSong),
    rate: status.playRate,
  });
  return new DesktopLyricsSession(provider, {
    trackKey,
    snapshotDependencies: () => [
      trackKey(),
      music.playSong.name,
      artistName(),
      music.songLyric,
      music.songLyric.lrcData,
      music.songLyric.yrcData,
      status.lyricLoading,
      setting.desktopLyricStyle?.playedColor,
      setting.desktopLyricStyle?.unplayedColor,
      setting.desktopLyricStyle?.shadowColor,
      setting.desktopLyricStyle?.textBackgroundMask,
      setting.desktopLyricOptions?.font?.family,
      setting.desktopLyricOptions?.font?.size,
      setting.desktopLyricOptions?.font?.weight,
      setting.desktopLyricOptions?.font?.postScriptName,
      setting.desktopLyricOptions?.font?.style,
      setting.desktopLyricOptions?.isDoubleLine,
      setting.desktopLyricOptions?.position,
      setting.desktopLyricOptions?.limitBounds,
      setting.desktopLyricOptions?.showYrc,
      setting.desktopLyricOptions?.showTran,
      setting.desktopLyricOptions?.animation,
      setting.desktopLyricOptions?.alwaysShowPlayInfo,
    ],
    clockDependencies: () => [
      status.playStatus,
      status.playRate,
      status.getSongOffset(music.playSong),
    ],
    snapshot: () => ({
      ...clock(),
      playName: music.playSong.name,
      artistName: artistName(),
      loading: status.lyricLoading,
      style: parseDesktopLyricStyle(setting.desktopLyricStyle) ?? createDefaultDesktopLyricStyle(),
      options:
        parseDesktopLyricOptions(setting.desktopLyricOptions) ?? createDefaultDesktopLyricOptions(),
      lrcData: music.songLyric.lrcData.map((line) => ({
        ...line,
        words: line.words.map((word) => ({ ...word })),
      })),
      yrcData: music.songLyric.yrcData.map((line) => ({
        ...line,
        words: line.words.map((word) => ({ ...word })),
      })),
    }),
    clock,
    onSeek: (listener) => player.onSeek(listener),
    execute: async (command) => {
      if (command.trackKey !== trackKey()) return;
      if (command.action === "previous") await player.nextOrPrev("prev");
      else if (command.action === "toggle") await player.playOrPause();
      else if (command.action === "next") await player.nextOrPrev("next");
      else if (command.action === "open-settings") {
        const { openSetting } = await import("@/utils/modal");
        await openSetting("lyrics", "showDesktopLyric");
      }
    },
  });
}
