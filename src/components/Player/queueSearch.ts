import type { SongInfo } from "@/types/main.hemusic";

export function normalizeQueueSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

export function filterQueueSongs<T extends Pick<SongInfo, "name" | "artists">>(
  songs: T[],
  normalizedQuery: string,
): T[] {
  if (!normalizedQuery) return songs;
  const words = normalizedQuery.split(" ");
  return songs.filter(({ name, artists }) => {
    const fields = [
      name,
      ...(Array.isArray(artists) ? artists.map(({ name }) => name) : [artists ?? ""]),
    ];
    const searchable = fields.map(normalizeQueueSearch);
    return words.every((word) => searchable.some((field) => field.includes(word)));
  });
}
