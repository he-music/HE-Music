import { computed, shallowRef } from "vue";
import { expect, it } from "vitest";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { useMygoDownloadedSongs, type MygoDownloadedSongsOwner } from "./mygoDownloadedSongs";

function entry(token = "grant", path = "album/song.flac"): ScanEntry {
  return {
    ref: { grantToken: token, fileId: `${token}:${path}`, version: "v1", relativePath: path },
    relativePath: path,
    filename: "song.flac",
    size: 1024,
    metadata: {
      Title: "Fresh title",
      Artists: ["Fresh artist"],
      Album: "Fresh album",
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
function task(id = "committed", overrides: Partial<LocalDownloadTask> = {}): LocalDownloadTask {
  return {
    id,
    filename: "song.flac",
    label: "History title",
    quality: "lossless",
    phase: "success",
    done: true,
    committed: true,
    received: 1024,
    total: 1024,
    percent: 100,
    refresh: "complete",
    retryable: false,
    target: { directory: "/Music", relativePath: "album/song.flac" },
    ...overrides,
  };
}
function fixture() {
  const entries = shallowRef<readonly ScanEntry[]>([entry()]);
  const owner = shallowRef<MygoDownloadedSongsOwner | undefined>({
    ready: shallowRef(true),
    directories: computed(() => [{ token: "grant", displayPath: "/Music", epoch: 1 }]),
    get libraryEntries() {
      return entries.value;
    },
  });
  const tasks = shallowRef<readonly LocalDownloadTask[]>([task()]);
  return { entries, owner, tasks, ...useMygoDownloadedSongs(owner, tasks) };
}
it("projects fresh matching entries with the real library row identity and no capabilities", () => {
  const f = fixture();
  expect(f.songs.value).toMatchObject([
    {
      id: "mygo-local:grant:album/song.flac",
      name: "Fresh title",
      artists: "Fresh artist",
      album: "Fresh album",
      platform: "local",
      duration: 42,
    },
  ]);
  expect(JSON.stringify(f.songs.value)).not.toMatch(/grantToken|version|History title/);
  expect(f.unmatched.value).toEqual([]);
  const row = f.songs.value[0];
  f.entries.value = [...f.entries.value];
  expect(f.songs.value[0]).toBe(row);
  f.tasks.value = [...f.tasks.value, task("duplicate")];
  expect(f.songs.value).toHaveLength(1);
});
it("requires committed targets plus the exact current directory and relative path", () => {
  const f = fixture();
  f.tasks.value = [
    task("failed", { committed: false }),
    task("old-directory", { target: { directory: "/Other", relativePath: "album/song.flac" } }),
    task("old-path", { target: { directory: "/Music", relativePath: "song.flac" } }),
    task("history-without-target", { target: undefined }),
  ];
  expect(f.songs.value).toEqual([]);
  expect(f.unmatched.value.map((item) => item.id)).toEqual([
    "old-directory",
    "old-path",
    "history-without-target",
  ]);
  f.tasks.value = [task()];
  f.entries.value = [entry("stale-grant"), entry("grant", "different/song.flac")];
  expect(f.songs.value).toEqual([]);
  expect(f.unmatched.value).toEqual(f.tasks.value);
  f.entries.value = [{ ...entry(), ref: { ...entry().ref, relativePath: "different.flac" } }];
  expect(f.songs.value).toEqual([]);
});
it("clears immediately on permission expiry, grant revocation, owner replacement and missing owner", () => {
  const f = fixture();
  expect(f.songs.value).toHaveLength(1);
  f.owner.value!.ready.value = false;
  expect(f.songs.value).toEqual([]);
  expect(f.unmatched.value).toHaveLength(1);
  f.owner.value!.ready.value = true;
  expect(f.songs.value).toHaveLength(1);
  f.owner.value = {
    ready: shallowRef(true),
    directories: computed(() => []),
    libraryEntries: f.entries.value,
  };
  expect(f.songs.value).toEqual([]);
  f.owner.value = {
    ready: shallowRef(true),
    directories: computed(() => [{ token: "grant", displayPath: "/Music", epoch: 2 }]),
    libraryEntries: [],
  };
  expect(f.songs.value).toEqual([]);
  f.entries.value = [entry()];
  expect(f.songs.value).toEqual([]);
  f.owner.value = undefined;
  expect(f.songs.value).toEqual([]);
});
it("reacts when scanning publishes entries after the owner becomes ready", () => {
  const f = fixture();
  f.entries.value = [];
  expect(f.songs.value).toEqual([]);
  f.entries.value = [entry()];
  expect(f.songs.value).toHaveLength(1);
  f.entries.value = [];
  expect(f.songs.value).toEqual([]);
});

it("keeps completed song props stable while active task progress changes", () => {
  const f = fixture();
  const songs = f.songs.value;
  for (const percent of [10, 20, 30]) {
    f.tasks.value = [task(), task("active", { committed: false, percent })];
    expect(f.songs.value).toBe(songs);
  }
  f.tasks.value = [task("other", { target: { directory: "/Music", relativePath: "other.flac" } })];
  expect(f.songs.value).toEqual([]);
});
