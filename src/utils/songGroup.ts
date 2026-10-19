import type { SongInfo } from "@/types/main.hemusic";

/** 依次处理字面分隔符；结构化歌手名称保持完整。 */
export function splitArtistNames(artists: SongInfo["artists"], separators: readonly string[]) {
  if (Array.isArray(artists)) return artists.map((artist) => artist.name).filter(Boolean);
  if (!artists) return [];
  let names = [artists];
  for (const separator of separators) {
    if (separator) names = names.flatMap((name) => name.split(separator));
  }
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

/** 每首歌可以进入多个分组，同一分组内按平台和歌曲 ID 去重。 */
export function groupSongs(
  songs: readonly SongInfo[],
  getNames: (song: SongInfo) => readonly string[],
): Map<string, SongInfo[]> {
  const groups = new Map<string, { songs: SongInfo[]; seen: Set<string> }>();
  for (const song of songs) {
    const identity = JSON.stringify([song.platform, song.id]);
    for (const name of getNames(song)) {
      let group = groups.get(name);
      if (!group) {
        group = { songs: [], seen: new Set() };
        groups.set(name, group);
      }
      if (!group.seen.has(identity)) {
        group.seen.add(identity);
        group.songs.push(song);
      }
    }
  }
  return new Map(
    [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, group.songs]),
  );
}
