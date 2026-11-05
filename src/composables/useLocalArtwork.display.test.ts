import { afterEach, expect, it, vi } from "vitest";
import { reactive, shallowRef } from "vue";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import { useLocalArtwork } from "./useLocalArtwork";

const state = vi.hoisted(() => ({
  settings: { showLocalCover: true },
  owner: { ready: { value: true }, directories: { value: [{ token: "grant" }] } },
  entries: [] as ScanEntry[],
}));
vi.mock("@/stores", () => ({ useSettingStore: () => state.settings }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return state.owner;
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: (id: string) => state.entries.find((entry) => entry.ref.fileId === id),
}));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  state.settings = reactive({ showLocalCover: true });
  state.owner = reactive({ ready: { value: true }, directories: { value: [{ token: "grant" }] } });
  state.entries = [
    localEntry("/Music/one/song.mp3", "one"),
    localEntry("/Music/two/song.mp3", "two"),
  ];
  const song = shallowRef(localSong(state.entries[0]));
  const enabled = shallowRef(true);
  const artwork = useLocalArtwork(song, enabled);
  return { song, enabled, artwork };
}

it("uses absolute paths to distinguish same-name files in multiple music directories", () => {
  const f = fixture();
  const first = f.artwork.url.value!;
  expect(new URL(first).searchParams.get("path")).toBe("/Music/one/song.mp3");
  f.song.value = { ...f.song.value, id: "two" };
  expect(new URL(f.artwork.url.value!).searchParams.get("path")).toBe("/Music/two/song.mp3");
  expect(f.artwork.url.value).not.toBe(first);
});

it("releases the image source when hidden, disabled or removed from the library", () => {
  const f = fixture();
  expect(f.artwork.url.value).toContain("/__local/artwork?");
  f.enabled.value = false;
  expect(f.artwork.url.value).toBeUndefined();
  f.enabled.value = true;
  state.settings.showLocalCover = false;
  expect(f.artwork.url.value).toBeUndefined();
  state.settings.showLocalCover = true;
  expect(f.artwork.url.value).toBeTruthy();
  state.owner.directories.value = [];
  expect(f.artwork.url.value).toBeUndefined();
});
