import type { Link, SongInfo } from "@/types/main.hemusic";
import { cloneDeep } from "lodash-es";

import { getActivePinia } from "pinia";
import { useSettingStore } from "@/stores/setting";
import { isMyGo } from "mygo-runtime";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
/** 创建与来源数据隔离的播放歌曲副本。 */
export const createPlaybackSongSnapshot = (song: SongInfo): SongInfo => {
  return cloneDeep(song);
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
