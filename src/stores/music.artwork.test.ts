import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { createRenderer, defineComponent, nextTick, shallowRef } from "vue";
import persist from "pinia-plugin-persistedstate";
import { installLocalArtworkReader } from "@/platform/localArtwork";

vi.mock("@/utils/format", () => ({ getSizeCover: (song: { cover: string }) => song.cover }));
vi.mock("@/utils/env", () => ({ isElectron: false }));
vi.mock("@/utils/blob", () => ({ default: { revokeBlobURL: vi.fn() } }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/utils/helper", () => ({ shuffleArray: <T>(values: T[]) => values }));
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: vi.fn((key: string, value: string) => {
    values.set(key, value);
  }),
};
vi.stubGlobal("localStorage", storage);
const { useMusicStore } = await import("./music");
const cleanups: Array<() => void> = [];
let music: ReturnType<typeof useMusicStore>;
beforeEach(() => {
  values.clear();
  storage.setItem.mockClear();
  const renderer = createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const pinia = createPinia().use(persist);
  const app = renderer.createApp(
    defineComponent({
      setup() {
        music = useMusicStore();
        return () => null;
      },
    }),
  );
  app.use(pinia);
  app.mount({});
  cleanups.push(() => {
    app.unmount();
    music.$dispose();
  });
  music.$patch({
    playSong: {
      id: "mygo-local:file",
      platform: "local",
      path: "album/song.mp3",
      cover: "/images/song.jpg?asset",
    },
  });
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
});

it("reactively presents a private artwork URL without persisting it or mutating playSong", async () => {
  const url = shallowRef<string | undefined>("blob:private-artwork");
  cleanups.push(
    installLocalArtworkReader((id, platform, path) =>
      id === "mygo-local:file" && platform === "local" && path === "album/song.mp3"
        ? url.value
        : undefined,
    ),
  );
  expect(music.songCover).toBe("blob:private-artwork");
  expect(music.getSongCover(512)).toBe("blob:private-artwork");
  expect(music.playSong.cover).toBe("/images/song.jpg?asset");
  await nextTick();
  const writes = storage.setItem.mock.calls.length;
  url.value = "blob:next-artwork";
  expect(music.songCover).toBe("blob:next-artwork");
  await nextTick();
  expect(storage.setItem).toHaveBeenCalledTimes(writes);
  expect(values.get("music-store")).toBeDefined();
  expect(values.get("music-store")).not.toContain("blob:");
  expect(values.get("music-store")).not.toContain("grantToken");
  url.value = undefined;
  expect(music.songCover).toBe("/images/song.jpg?asset");
});

it("keeps a newer artwork owner when an old shell disposes and preserves the online fallback", () => {
  const old = installLocalArtworkReader(() => "blob:old");
  const stop = installLocalArtworkReader(() => "blob:new");
  cleanups.push(stop);
  old();
  expect(music.songCover).toBe("blob:new");
  stop();
  expect(music.songCover).toBe("/images/song.jpg?asset");
  music.playSong.path = undefined;
  music.playSong.cover = "https://fixture.invalid/cover.jpg";
  cleanups.push(installLocalArtworkReader(() => "blob:must-not-use"));
  expect(music.songCover).toBe("https://fixture.invalid/cover.jpg");
});

it("fails safely when the current reader rejects its lease", () => {
  cleanups.push(
    installLocalArtworkReader(() => {
      throw new Error("fixture lease");
    }),
  );
  expect(music.songCover).toBe("/images/song.jpg?asset");
});
