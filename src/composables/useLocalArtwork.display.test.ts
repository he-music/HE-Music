import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, shallowRef, type Ref } from "vue";
import type { Info, LocalFileRef, MetadataResult } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";
import type { LocalDisplayOwner } from "@/platform/localDisplayRead";
import { VisibleArtworkCache } from "@/platform/visibleArtworkCache";

interface Entry {
  relativePath: string;
  ref: LocalFileRef;
}
interface Owner extends LocalDisplayOwner {
  directories: Ref<Array<{ token: string }>>;
}
const state = vi.hoisted(() => ({
  source: undefined as Ref<Owner | undefined> | undefined,
  entries: undefined as Ref<Entry[]> | undefined,
  settings: undefined as { showLocalCover: boolean } | undefined,
}));
vi.mock("@/platform/filesSession", async () => {
  const vue = await import("vue");
  state.source = vue.shallowRef<Owner>();
  return { filesSession: state.source };
});
vi.mock("@/platform/localFilesSession", async () => {
  const vue = await import("vue");
  state.entries = vue.shallowRef<Entry[]>([]);
  return {
    nativeLocalEntry: (id: string) =>
      state.entries?.value.find((entry) => `mygo-local:${entry.ref.fileId}` === id),
    localFilesSession: vue.shallowRef({ entries: state.entries }),
  };
});
vi.mock("@/stores", async () => {
  const vue = await import("vue");
  state.settings = vue.reactive({ showLocalCover: true });
  return { useSettingStore: () => state.settings };
});
import { useLocalArtwork } from "./useLocalArtwork";

const ref: LocalFileRef = {
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "song",
  version: "v1",
};
function result(current = ref): MetadataResult {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  const info: Info = {
    Container: "",
    Title: "",
    Artists: [],
    Album: "",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    PicturesLoaded: true,
    Pictures: [
      { MIME: "image/png", Type: 3, Description: "", Data: Buffer.from(bytes).toString("base64") },
    ],
    DurationSeconds: 0,
    BitrateKbps: 0,
    SampleRateHz: 0,
    Channels: 0,
    BitsPerSample: 0,
    Codec: "",
  };
  return { code: "ok", ref: { ...current }, info, committed: false };
}
const song = (): SongInfo => ({
  id: "mygo-local:song",
  name: "song",
  platform: "local",
  path: "song.mp3",
  cover: "/images/song.jpg?asset",
  subtitle: "",
  artists: "",
  album: "",
  duration: 0,
  mv_id: "",
  links: [],
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await nextTick();
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
});
function fixture(reader = vi.fn(async () => result())) {
  const owner: Owner = {
    ready: shallowRef(true),
    directories: shallowRef([{ token: "grant" }]),
    displayAccess: () => ({ current: () => owner.ready.value, read: reader }),
  };
  state.source!.value = owner;
  state.entries!.value = [{ relativePath: ref.relativePath, ref: { ...ref } }];
  state.settings!.showLocalCover = true;
  let serial = 0;
  const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++serial}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const mount = (value = shallowRef(song()), enabled = shallowRef(true)) => {
    const scope = effectScope();
    const artwork = scope.run(() => useLocalArtwork(value, enabled))!;
    cleanups.push(() => scope.stop());
    return { value, enabled, artwork, stop: () => scope.stop() };
  };
  return { owner, reader, create, revoke, mount };
}

describe("useLocalArtwork display seam", () => {
  it("refreshes a new scan identity/version while preserving unchanged rows", async () => {
    const reader = vi.fn(async () => result(state.entries!.value[0].ref));
    const h = fixture(reader);
    const row = h.mount();
    await settle();
    const prior = state.entries!.value[0];
    state.entries!.value = [prior];
    await settle();
    expect(reader).toHaveBeenCalledOnce();
    state.entries!.value = [{ ...prior, ref: { ...prior.ref, version: "v2" } }];
    await settle();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(h.revoke).toHaveBeenCalledWith("blob:1");
    expect(row.artwork.url.value).toBe("blob:2");
    state.entries!.value = [{ ...state.entries!.value[0] }];
    await settle();
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("shares a display read, does not mutate persisted cover, and ignores unrelated directories", async () => {
    const h = fixture();
    const a = h.mount();
    const b = h.mount();
    await settle();
    expect(h.reader).toHaveBeenCalledOnce();
    expect(a.artwork.url.value).toBe("blob:1");
    expect(b.artwork.url.value).toBe("blob:1");
    h.owner.directories.value = [{ token: "grant" }, { token: "unrelated" }];
    await settle();
    expect(h.reader).toHaveBeenCalledOnce();
    expect(h.create).toHaveBeenCalledOnce();
    expect(a.value.value.cover).toBe("/images/song.jpg?asset");
    a.stop();
    expect(h.revoke).not.toHaveBeenCalled();
    b.stop();
    expect(h.revoke).toHaveBeenCalledWith("blob:1");
  });
  it("reuses bytes on scrolling, clears idle bytes on revoke and respects disable", async () => {
    const h = fixture();
    const keeper = h.mount();
    const row = h.mount();
    await settle();
    row.enabled.value = false;
    await settle();
    row.enabled.value = true;
    await settle();
    expect(h.reader).toHaveBeenCalledOnce();
    h.owner.directories.value = [];
    await settle();
    expect(keeper.artwork.url.value).toBeUndefined();
    expect(row.artwork.url.value).toBeUndefined();
    expect(h.revoke).toHaveBeenCalledWith("blob:1");
    state.settings!.showLocalCover = false;
    await settle();
    h.owner.directories.value = [{ token: "grant" }];
    await settle();
    expect(h.reader).toHaveBeenCalledOnce();
  });
  it("drops late results and uses the old song cover without an optional reader", async () => {
    let resolve!: (value: MetadataResult) => void;
    const reader = vi.fn(
      () =>
        new Promise<MetadataResult>((done) => {
          resolve = done;
        }),
    );
    const h = fixture(reader);
    const row = h.mount();
    await settle();
    row.stop();
    resolve(result());
    await settle();
    expect(h.create).not.toHaveBeenCalled();
    h.owner.displayAccess = undefined;
    const fallback = h.mount();
    await settle();
    expect(fallback.artwork.url.value).toBeUndefined();
    expect(fallback.value.value.cover).toBe("/images/song.jpg?asset");
  });
});

it("VisibleArtworkCache checks cache hits and reuses bounded bytes after revoking idle URLs", async () => {
  let current = true;
  let serial = 0;
  const read = vi.fn(async () => result());
  const revoke = vi.fn();
  const cache = new VisibleArtworkCache({
    read,
    isCurrent: () => current,
    createURL: () => `blob:${++serial}`,
    revokeURL: revoke,
    maxEntries: 1,
  });
  const target = {
    songID: "mygo-local:song",
    platform: "local",
    relativePath: ref.relativePath,
    ref,
  };
  const a = cache.acquire(target);
  await settle();
  a.release();
  expect(revoke).toHaveBeenCalledWith("blob:1");
  const b = cache.acquire(target);
  await settle();
  expect(b.url.value).toBe("blob:2");
  expect(read).toHaveBeenCalledOnce();
  current = false;
  expect(cache.acquire(target).url.value).toBeUndefined();
  cache.prune();
  expect(b.url.value).toBeUndefined();
  expect(revoke).toHaveBeenCalledWith("blob:2");
  cache.dispose();
});

it("VisibleArtworkCache enforces its image byte budget and caches a missing cover", async () => {
  const read = vi.fn(async () => result());
  const createURL = vi.fn(() => "blob:overflow");
  const cache = new VisibleArtworkCache({
    read,
    isCurrent: () => true,
    createURL,
    revokeURL: vi.fn(),
    maxBytes: 32,
  });
  const target = {
    songID: "mygo-local:song",
    platform: "local",
    relativePath: ref.relativePath,
    ref,
  };
  const first = cache.acquire(target);
  await settle();
  expect(first.url.value).toBeUndefined();
  expect(createURL).not.toHaveBeenCalled();
  first.release();
  const second = cache.acquire(target);
  await settle();
  expect(read).toHaveBeenCalledOnce();
  second.release();
  cache.dispose();
});
