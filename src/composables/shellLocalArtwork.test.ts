import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reactive, shallowRef, watch } from "vue";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import { localArtworkForSong } from "@/platform/localArtwork";
import { createShellLocalArtworkSession } from "./shellLocalArtwork";

const host = vi.hoisted(() => ({ kind: "mygo", files: {} }));
const entries = shallowRef([localEntry()]);
const music = reactive({ playSong: localSong(entries.value[0]) });
const owner = { ready: shallowRef(true), directories: shallowRef([{ token: "grant" }]) };
vi.mock("@/platform", () => ({ platform: host }));
vi.mock("@/stores", () => ({ useMusicStore: () => music }));
vi.mock("@/utils/player", () => ({ usePlayer: () => ({ updateArtworkTheme: vi.fn() }) }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return owner;
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: (id: string) => entries.value.find((entry) => entry.ref.fileId === id),
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  host.kind = "mygo";
  entries.value = [localEntry()];
  music.playSong = localSong(entries.value[0]);
  owner.ready.value = true;
  owner.directories.value = [{ token: "grant" }];
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  vi.unstubAllGlobals();
});
function mount() {
  const theme = vi.fn();
  const session = createShellLocalArtworkSession({ onTheme: theme });
  cleanups.push(() => session?.dispose());
  return { theme, session };
}

it("publishes an HTTP cover without writing a temporary URL into the song", async () => {
  const { theme } = mount();
  const url = localArtworkForSong(music.playSong)!;
  expect(new URL(url).searchParams.get("path")).toBe("/Music/song.mp3");
  expect(music.playSong.cover).toBe("/images/song.jpg?asset");
  await Promise.resolve();
  expect(theme).toHaveBeenCalledWith(url);
});

it("refreshes the URL on rescan and clears it on revoke", () => {
  mount();
  const first = localArtworkForSong(music.playSong);
  entries.value = [{ ...entries.value[0] }];
  expect(localArtworkForSong(music.playSong)).not.toBe(first);
  owner.directories.value = [];
  expect(localArtworkForSong(music.playSong)).toBeUndefined();
});

it("updates URL consumers on song changes", () => {
  mount();
  const updates = vi.fn();
  cleanups.push(watch(() => localArtworkForSong(music.playSong), updates, { flush: "sync" }));
  entries.value = [localEntry("/Other/song.mp3", "next")];
  music.playSong = localSong(entries.value[0]);
  expect(localArtworkForSong(music.playSong)).toContain("/__local/artwork?");
  expect(updates).toHaveBeenCalled();
});

it("an older shell's disposal cannot remove the current reader", () => {
  const old = mount();
  mount();
  old.session?.dispose();
  expect(localArtworkForSong(music.playSong)).toBeTruthy();
});
