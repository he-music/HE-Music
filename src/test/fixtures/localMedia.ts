import type { ScanEntry } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

export function localEntry(path = "/Music/song.mp3", id = "file"): ScanEntry {
  return {
    path,
    relativePath: "song.mp3",
    filename: "song.mp3",
    ref: { fileId: id, grantToken: "grant", relativePath: "song.mp3", version: "v1" },
    size: 20,
    metadata: {
      Container: "mp3",
      Title: "Song",
      Artists: [],
      Album: "",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      DurationSeconds: 1,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 0,
      Codec: "MPEG",
    },
  };
}

export function localSong(entry: ScanEntry): SongInfo {
  return {
    id: entry.ref.fileId,
    platform: "local",
    path: entry.relativePath,
    name: "Song",
    subtitle: "",
    album: "",
    artists: "",
    links: [],
    mv_id: "",
    cover: "/images/song.jpg?asset",
    duration: 1,
  };
}
