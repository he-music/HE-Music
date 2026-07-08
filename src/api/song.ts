import request, { API_URL, requestHemusic } from "@/utils/request";
import { isElectron } from "@/utils/env";
import type { MVInfo, PlaylistInfo, SongInfo, SongMetadata } from "@/types/main.hemusic";

export interface SongDetailResponse {
  song: SongInfo;
  metadata: SongMetadata;
}

export interface SongRelationsResponse {
  similar_songs: SongInfo[];
  related_playlists: PlaylistInfo[];
  related_mvs: MVInfo[];
  other_version_songs: SongInfo[];
}

// 获取歌曲 URL
export const songUrl = (
  id: string,
  platform: string,
  quality: number = 320,
  format: string = "mp3",
) => {
  return requestHemusic({
    url: "/v1/song/url",
    params: {
      id,
      platform,
      quality,
      format,
    },
  });
};

// 获取解锁歌曲 URL
export const unlockSongUrl = (
  id: string,
  keyword: string,
  server: "netease" | "kuwo" | "bodian",
) => {
  const params = server === "netease" ? { id: Number(id) } : { keyword };
  return request({
    baseURL: "/api/unblock",
    url: `/${server}`,
    params,
  });
};

// 获取歌曲歌词
export const songLyric = (id: string, platform: string) => {
  return requestHemusic({
    url: "/v1/song/lyric",
    params: {
      id,
      platform,
    },
  });
};

// 获取歌曲歌词
export const neteaseSongLyric = (id: number) => {
  return request({
    url: "/lyric/new",
    params: {
      id,
    },
  });
};

/**
 * 本地歌曲文件匹配
 * @param {string} title - 文件的标题信息，是文件属性里的标题属性，并非文件名
 * @param {string} album - 文件的专辑信息
 * @param {string} artist - 文件的艺术家信息
 * @param {number} duration - 文件的时长，单位为秒
 * @param {string} md5 - 文件的 md5
 */

export const matchSong = (
  title: string,
  artist: string,
  album: string,
  duration: number,
  md5: string,
) => {
  return request({
    url: "/search/match",
    params: { title, artist, album, duration, md5 },
  });
};

/**
 * 歌曲动态封面
 * @param {number} id - 歌曲 id
 */

export const songDynamicCover = (id: number) => {
  return request({
    url: "/song/dynamic/cover",
    params: { id },
  });
};

export const newSongTabs = (platform: string) => {
  return requestHemusic({
    url: "/v1/song/new/tabs",
    params: { platform },
  });
};
export const newSongs = (
  platform: string,
  tab_id: string,
  page_index = 1,
  page_size: number = 30,
) => {
  return requestHemusic({
    url: "/v1/song/tab/news",
    params: { platform, tab_id, page_size, page_index },
  });
};
export const songInfo = (platform: string, id: string) => {
  return requestHemusic({
    url: "/v1/song",
    params: { ids: id, platform },
  });
};

// 获取歌曲详情
export const songDetail = (id: string, platform: string): Promise<SongDetailResponse> => {
  return requestHemusic({
    url: "/v1/song/detail",
    params: { id, platform },
  });
};

// 获取歌曲关联数据
export const songRelations = (id: string, platform: string): Promise<SongRelationsResponse> => {
  return requestHemusic({
    url: "/v1/song/relations",
    params: { id, platform },
  });
};

export const getCoverUrlStr = (
  platform: string,
  id: string,
  quality = 300,
  redirect = true,
  token = "",
) =>
  `${API_URL}/v1/song/cover?${new URLSearchParams({
    id,
    platform,
    quality: quality.toString(),
    redirect: redirect.toString(),
    token,
  }).toString()}`;

/**
 * 获取歌曲 TTML 歌词
 * @param id 音乐 id
 * @returns TTML 格式歌词
 */
export const songLyricTTML = async (id: number) => {
  if (isElectron) {
    return request({ url: "/lyric/ttml", params: { id, noCookie: true } });
  } else {
    const url = `https://amll-ttml-db.stevexmh.net/ncm/${id}`;
    try {
      const response = await fetch(url);
      if (response === null || response.status !== 200) {
        return null;
      }
      const data = await response.text();
      return data;
    } catch {
      return null;
    }
  }
};
