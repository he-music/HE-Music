import { computed, shallowRef } from "vue";
import { expect, it } from "vitest";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { useMygoDownloadedSongs, type MygoDownloadedSongsOwner } from "./mygoDownloadedSongs";

function entry(token = "downloads", path = "album/song.flac"): ScanEntry {
  return {
    ref: { grantToken: token, fileId: `${token}:${path}`, version: "v1", relativePath: path },
    relativePath: path,
    filename: "song.flac",
    size: 1024,
    metadata: {
      Title: "Directory song",
      Artists: ["Artist"],
      Album: "Album",
      DurationSeconds: 42,
      Container: "FLAC",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 16,
      Codec: "FLAC",
    },
  };
}
function fixture() {
  const entries = shallowRef<readonly ScanEntry[]>([entry(), entry("music")]);
  const grants = shallowRef([
    { token: "downloads", displayPath: "/Downloads", epoch: 1 },
    { token: "music", displayPath: "/Music", epoch: 1 },
  ]);
  const owner = shallowRef<MygoDownloadedSongsOwner | undefined>({
    ready: shallowRef(true),
    directories: computed(() => grants.value),
    get libraryEntries() {
      return entries.value;
    },
  });
  const directory = shallowRef("/Downloads");
  return { entries, grants, owner, directory, ...useMygoDownloadedSongs(owner, directory) };
}
it("shows every scanned song in the configured directory without requiring download history", () => {
  const f = fixture();
  expect(f.songs.value).toMatchObject([
    { name: "Directory song", platform: "local", id: "mygo-local:downloads:album/song.flac" },
  ]);
  expect(JSON.stringify(f.songs.value)).not.toMatch(/grantToken|version/);
  const previous = f.songs.value[0];
  f.entries.value = [...f.entries.value];
  expect(f.songs.value[0]).toBe(previous);
});
it("switches the entire list when the default download directory changes", () => {
  const f = fixture();
  f.directory.value = "/Music";
  expect(f.songs.value[0].id).toBe("mygo-local:music:album/song.flac");
  f.directory.value = "/missing";
  expect(f.songs.value).toEqual([]);
  f.directory.value = "";
  expect(f.songs.value).toEqual([]);
});
it("clears immediately on initialization, revoked grants, owner changes and removal", () => {
  const f = fixture();
  f.owner.value!.ready.value = false;
  expect(f.songs.value).toEqual([]);
  f.owner.value!.ready.value = true;
  expect(f.songs.value).toHaveLength(1);
  f.grants.value = [];
  expect(f.songs.value).toEqual([]);
  f.owner.value = { ready: shallowRef(true), directories: computed(() => []), libraryEntries: [] };
  expect(f.songs.value).toEqual([]);
  f.owner.value = undefined;
  expect(f.songs.value).toEqual([]);
});
it("rejects stale or mismatched file references and follows fresh scans", () => {
  const f = fixture();
  f.entries.value = [
    entry("stale"),
    { ...entry(), ref: { ...entry().ref, relativePath: "other.flac" } },
  ];
  expect(f.songs.value).toEqual([]);
  f.entries.value = [entry()];
  expect(f.songs.value).toHaveLength(1);
});
