import { computed, type Ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import type { ScanEntry } from "./mygo.bindings";
import { localSongID } from "./localFilesSession";

export interface LibrarySongRow extends SongInfo {
  artists: string;
  album: string;
}

/** Reuse rows for unchanged entries; native capabilities remain in the scan session. */
export function createLibrarySongRows(entries: Readonly<Ref<readonly ScanEntry[]>>) {
  const cache = new WeakMap<ScanEntry, LibrarySongRow>();
  return computed(() =>
    entries.value.map((entry) => {
      const previous = cache.get(entry);
      if (previous) return previous;
      const song: LibrarySongRow = {
        id: localSongID(entry),
        name: entry.metadata.Title || entry.filename,
        subtitle: "",
        artists: entry.metadata.Artists.join(" / "),
        album: entry.metadata.Album,
        duration: entry.metadata.DurationSeconds,
        path: entry.relativePath,
        size: entry.size,
        mv_id: "",
        platform: "local",
        links: [],
        cover: "/images/song.jpg?asset",
      };
      cache.set(entry, song);
      return song;
    }),
  );
}

export function filterLibrarySongs(songs: LibrarySongRow[], query: string): LibrarySongRow[] {
  const search = query.trim().toLocaleLowerCase();
  if (!search) return songs;
  return songs.filter((song) =>
    [song.name, song.artists, song.album].some((value) =>
      value.toLocaleLowerCase().includes(search),
    ),
  );
}
