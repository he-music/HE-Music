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
function record(
  id = "download",
  directory = "/Downloads",
): import("@/platform/localDownloadSession").LocalDownloadTask {
  return {
    id,
    filename: "song.flac",
    label: "Original title",
    quality: "flac",
    song: { id: "online-id", platform: "provider" },
    target: { directory, relativePath: "album/song.flac" },
    phase: "success",
    done: true,
    committed: true,
    received: 1024,
    total: 1024,
    percent: 100,
    refresh: "none",
    retryable: false,
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
  const records = shallowRef([record()]);
  return { entries, grants, owner, records, ...useMygoDownloadedSongs(owner, records) };
}
it("binds only files associated with completed records and never imports unrelated directory songs", () => {
  const f = fixture();
  expect(f.songs.value).toHaveLength(1);
  expect(f.files.value.has("download")).toBe(true);
  expect(f.records.value[0].song).toEqual({ id: "online-id", platform: "provider" });
  expect(f.records.value[0].label).toBe("Original title");
  f.records.value = [];
  expect(f.songs.value).toEqual([]);
  expect(f.entries.value).toHaveLength(2);
});
it("keeps records when the downloaded file is missing, moved, or no longer authorized", () => {
  const f = fixture();
  const original = f.records.value[0];
  f.entries.value = [];
  expect(f.files.value.size).toBe(0);
  expect(f.records.value).toEqual([original]);
  f.entries.value = [entry()];
  expect(f.files.value.has(original.id)).toBe(true);
  f.grants.value = [];
  expect(f.files.value.size).toBe(0);
  expect(f.records.value[0]).toBe(original);
  f.owner.value = undefined;
  expect(f.songs.value).toEqual([]);
  expect(f.records.value).toEqual([original]);
});
it("uses each record's captured target across changes to the configured download directory", () => {
  const f = fixture();
  f.records.value = [record("old"), record("new", "/Music")];
  expect([...f.files.value.keys()]).toEqual(["old", "new"]);
  f.entries.value = [entry("music")];
  expect([...f.files.value.keys()]).toEqual(["new"]);
  expect(f.records.value).toHaveLength(2);
});
it("rejects stale and mismatched references and keeps stable file rows for unchanged entries", () => {
  const f = fixture();
  const song = f.songs.value[0];
  f.entries.value = [...f.entries.value];
  expect(f.songs.value[0]).toBe(song);
  f.entries.value = [{ ...entry(), ref: { ...entry().ref, relativePath: "different.flac" } }];
  expect(f.songs.value).toEqual([]);
  f.owner.value!.ready.value = false;
  expect(f.songs.value).toEqual([]);
});
