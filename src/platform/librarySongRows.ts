import { computed, type Ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import type { ScanEntry } from "./mygo.bindings";
import { localSongID } from "./localFilesSession";

export interface LibrarySongRow extends SongInfo {
  artists: string;
  album: string;
}

const losslessCodecs = new Set([
  "flac",
  "alac",
  "pcm",
  "pcm-float",
  "ape",
  "tta",
  "tak",
  "wma-lossless",
]);

export function localSongQuality(
  info: ScanEntry["metadata"],
): "MASTER" | "HIRES" | "SQ" | "HQ" | undefined {
  if (!Number.isFinite(info.SampleRateHz) || info.SampleRateHz <= 0 || info.Channels <= 0) return;
  if (losslessCodecs.has(info.Codec.toLowerCase())) {
    if (info.SampleRateHz > 384000 || info.BitsPerSample >= 32) return "MASTER";
    if (info.SampleRateHz > 44100 || info.BitsPerSample > 16) return "HIRES";
    return "SQ";
  }
  if (Number.isFinite(info.BitrateKbps) && info.BitrateKbps >= 192) return "HQ";
  return undefined;
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
        quality: localSongQuality(entry.metadata),
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
