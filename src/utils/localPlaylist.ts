import type { SongInfo } from "@/types/main.hemusic";

export interface LocalPlaylist {
  id: string;
  name: string;
  cover: string;
  description: string;
  createdAt?: number;
  songs: SongInfo[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 只保存展示数据和稳定歌曲 ID；文件授权始终由当前曲库会话提供。 */
export function localPlaylistSong(song: unknown): SongInfo {
  if (
    !object(song) ||
    typeof song.id !== "string" ||
    !song.id.startsWith("mygo-local:path:") ||
    song.platform !== "local" ||
    typeof song.path !== "string" ||
    !song.path ||
    typeof song.name !== "string" ||
    typeof song.duration !== "number" ||
    !Number.isFinite(song.duration) ||
    song.duration < 0 ||
    typeof song.album !== "string" ||
    typeof song.artists !== "string"
  )
    throw new Error("Invalid local playlist song");
  return {
    id: song.id,
    name: song.name,
    duration: song.duration,
    album: song.album,
    artists: song.artists,
    path: song.path,
    platform: "local",
    subtitle: "",
    mv_id: "",
    links: [],
    cover: "/images/song.jpg?asset",
    ...(typeof song.quality === "string" ? { quality: song.quality } : {}),
    ...(typeof song.size === "number" && Number.isSafeInteger(song.size) && song.size >= 0
      ? { size: song.size }
      : {}),
  };
}

export function parseLocalPlaylists(value: unknown): LocalPlaylist[] {
  if (!Array.isArray(value)) throw new Error("Invalid local playlists");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100 ||
      !Array.isArray(item.songs) ||
      (item.cover !== undefined && typeof item.cover !== "string") ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 800)) ||
      (item.createdAt !== undefined &&
        (typeof item.createdAt !== "number" ||
          !Number.isSafeInteger(item.createdAt) ||
          item.createdAt < 0))
    )
      throw new Error("Invalid local playlist");
    ids.add(item.id);
    const songs = item.songs.map(localPlaylistSong);
    if (new Set(songs.map((song) => song.id)).size !== songs.length) {
      throw new Error("Duplicate local playlist song");
    }
    return {
      id: item.id,
      name: item.name,
      cover: typeof item.cover === "string" ? item.cover : "",
      description: typeof item.description === "string" ? item.description : "",
      ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {}),
      songs,
    };
  });
}
