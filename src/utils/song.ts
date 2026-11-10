import type { Link, SongInfo } from "@/types/main.hemusic";

import { getActivePinia } from "pinia";
import { useSettingStore } from "@/stores/setting";
import { isMyGo } from "mygo-runtime";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";

/** 创建与来源数据隔离且可写入 IndexedDB 的播放歌曲副本。 */
export const createPlaybackSongSnapshot = (song: SongInfo): SongInfo => {
  const snapshot: SongInfo = {
    name: song.name,
    subtitle: song.subtitle,
    id: song.id,
    duration: song.duration,
    mv_id: song.mv_id,
    album:
      typeof song.album === "string"
        ? song.album
        : { id: song.album?.id ?? "", name: song.album?.name ?? "" },
    artists: Array.isArray(song.artists)
      ? song.artists.map((artist) => ({ id: artist.id, name: artist.name }))
      : song.artists,
    links: Array.isArray(song.links)
      ? song.links.map((link) => ({
          name: link.name,
          quality: link.quality,
          format: link.format,
          size: link.size,
          url: link.url,
        }))
      : [],
    platform: song.platform,
    cover: song.cover,
  };

  if (song.path !== undefined) snapshot.path = song.path;
  if (song.size !== undefined) snapshot.size = song.size;
  if (song.quality !== undefined) snapshot.quality = song.quality;
  if (song.alias !== undefined) snapshot.alias = song.alias;

  return snapshot;
};

export const createPlaybackListSnapshot = (songs: SongInfo[]): SongInfo[] => {
  return songs.map(createPlaybackSongSnapshot);
};

export const songEqual = (a: SongInfo, b: SongInfo) => {
  return a?.id === b?.id && a?.platform === b?.platform;
};

export const getSongCanPlay = (a: SongInfo) => {
  return getSongCanPlayLinks(a)?.length > 0;
};

export const getSongCanDownload = (a: SongInfo) => {
  return a.links?.length > 0;
};

export const getSongCanPlayLinks = (
  { links }: SongInfo,
  engine: PlaybackEngineId = isMyGo() && getActivePinia()
    ? useSettingStore().playbackEngine
    : "web-audio",
) => {
  const res: Link[] = [];
  links.forEach((item) => {
    const { name, format } = item;
    if (
      name === "96wma" ||
      (engine !== "mpv" &&
        (name === "dsd" || ["dsd", "dsf", "dff"].includes(format?.toLowerCase())))
    ) {
      return;
    }
    // ape暂时不支持播放
    if (engine !== "mpv" && (name === "ape" || format?.toLowerCase() === "ape")) {
      return;
    }
    res.push(item);
  });
  return res;
};

export const IsValidId = (id: string) => {
  return id != "" && Number(id) != 0;
};
