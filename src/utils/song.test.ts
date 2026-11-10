import { expect, it } from "vitest";
import { createPlaybackSongSnapshot } from "./song";
import type { SongInfo } from "@/types/main.hemusic";

const song: SongInfo = {
  name: "Test Song",
  subtitle: "",
  id: "song-id",
  duration: 180,
  mv_id: "",
  album: { id: "album-id", name: "Test Album" },
  artists: [{ id: "artist-id", name: "Test Artist" }],
  links: [
    {
      name: "128mp3",
      quality: 128,
      format: "mp3",
      size: "1 MB",
      url: "https://example.com/song.mp3",
    },
  ],
  platform: "test",
  cover: "",
};

it("creates an IndexedDB-cloneable snapshot from a song with extra runtime fields", () => {
  const source = Object.assign({}, song, {
    runtimeMetadata: { onPlay: () => undefined },
  });

  const snapshot = createPlaybackSongSnapshot(source);

  expect(() => structuredClone(snapshot)).not.toThrow();
  expect(snapshot).toEqual(song);
});
