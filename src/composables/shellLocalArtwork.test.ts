import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computed, effectScope, reactive, ref, shallowRef } from "vue";
import type { LocalFileRef, MetadataResult, ScanEntry } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";
import { localArtworkForSong } from "@/platform/localArtwork";
import { readLocalDisplay } from "@/platform/localDisplayRead";

const host = vi.hoisted(() => ({ kind: "mygo", files: { readLocalArtwork: vi.fn() } }));
const entries = ref<ScanEntry[]>([]);
let music: { playSong: SongInfo };
const makeOwner = () => {
  const requests: Array<{
    ref: LocalFileRef;
    resolve: (result: MetadataResult | undefined) => void;
  }> = [];
  const result = {
    ready: ref(true),
    directories: ref([{ token: "grant", displayPath: "fixture", epoch: 1 }]),
    metadata: {
      read: vi.fn(
        (file: LocalFileRef) =>
          new Promise<MetadataResult | undefined>((resolve) => {
            requests.push({ ref: { ...file }, resolve });
          }),
      ),
    },
    displayAccess(file: LocalFileRef) {
      return {
        current: () => result.ready.value,
        read: async (): Promise<MetadataResult> =>
          (await result.metadata.read(file)) ?? { code: "revoked", committed: false },
      };
    },
    requests,
  };
  return result;
};
const owner = shallowRef<ReturnType<typeof makeOwner>>();
vi.mock("@/platform", () => ({ platform: host }));
vi.mock("@/stores", () => ({ useMusicStore: () => music }));
vi.mock("@/utils/player", () => ({ usePlayer: () => ({ updateArtworkTheme: vi.fn() }) }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return owner.value;
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: (id: string) =>
    entries.value.find((entry) => id === `mygo-local:${entry.ref.fileId}`),
}));
import { createShellLocalArtworkSession } from "./shellLocalArtwork";
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const entry = (id = "A"): ScanEntry => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 13);
  header.setUint32(12, 0x49484452);
  header.setUint32(16, 1);
  header.setUint32(20, 1);
  return {
    ref: { grantToken: "grant", fileId: id, version: "v1", relativePath: `${id}.mp3` },
    relativePath: `${id}.mp3`,
    filename: `${id}.mp3`,
    size: 1,
    metadata: {
      Container: "MP3",
      Title: id,
      Artists: [],
      Album: "",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      PicturesLoaded: true,
      Pictures: [
        {
          MIME: "image/png",
          Type: 3,
          Description: "",
          Data: Buffer.from(bytes).toString("base64"),
        },
      ],
      DurationSeconds: 1,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 0,
      Codec: "MPEG",
    },
  };
};
const song = (id = "A"): SongInfo => ({
  id: `mygo-local:${id}`,
  platform: "local",
  path: `${id}.mp3`,
  name: id,
  subtitle: "",
  cover: "/images/song.jpg?asset",
  album: "",
  links: [],
  duration: 1,
  mv_id: "",
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  host.kind = "mygo";
  owner.value = makeOwner();
  entries.value = [entry()];
  music = reactive({ playSong: song() });
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
});
function fixture() {
  const live = new Set<string>();
  let serial = 0;
  const theme = vi.fn();
  const createURL = vi.fn(() => {
    const url = `blob:cover-${++serial}`;
    live.add(url);
    return url;
  });
  const revoke = vi.fn((url: string) => {
    expect(live.delete(url)).toBe(true);
  });
  const scope = effectScope();
  const session = scope.run(() =>
    createShellLocalArtworkSession({ createURL, revokeURL: revoke, onTheme: theme }),
  );
  if (!session) throw new Error("No artwork capability");
  const stop = () => {
    session.dispose();
    scope.stop();
  };
  cleanups.push(stop);
  const cover = computed(() => localArtworkForSong(music.playSong));
  return { session, stop, live, createURL, revoke, theme, cover };
}
async function accept(f: ReturnType<typeof fixture>, index = 0) {
  await flush();
  const current = owner.value;
  if (!current) throw new Error("No owner");
  const request = current.requests[index];
  const currentEntry = entries.value.find((value) => value.ref.fileId === request.ref.fileId);
  if (!currentEntry) throw new Error("No registered entry");
  request.resolve({ code: "ok", committed: false, ref: request.ref, info: currentEntry.metadata });
  await flush();
  expect(f.cover.value).toMatch(/^blob:/);
}

it("presents the registered file's embedded image and shares an in-flight display artwork read", async () => {
  const current = owner.value;
  if (!current) throw new Error("No owner");
  const lyrics = readLocalDisplay(current, entries.value[0].ref, "artwork", entries.value[0]);
  const f = fixture();
  await accept(f);
  await lyrics;
  expect(current.metadata.read).toHaveBeenCalledOnce();
  expect(f.cover.value).toBe("blob:cover-1");
  expect(music.playSong.cover).toBe("/images/song.jpg?asset");
  current.directories.value.push({ token: "other", displayPath: "other", epoch: 1 });
  await flush();
  expect(current.metadata.read).toHaveBeenCalledOnce();
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.theme.mock.calls.map((call) => call[0])).toEqual(["", "blob:cover-1"]);
});

it("revokes immediately on grant loss and does not read again without authorization", async () => {
  const f = fixture();
  await accept(f);
  const current = owner.value;
  if (!current) throw new Error("No owner");
  current.directories.value = [];
  expect(f.cover.value).toBeUndefined();
  expect(f.live.size).toBe(0);
  expect(f.theme).toHaveBeenLastCalledWith("");
  await flush();
  expect(current.metadata.read).toHaveBeenCalledOnce();
});

it("clears a previous version, reads the new ref and ignores a late old-owner result", async () => {
  const f = fixture();
  await accept(f);
  entries.value[0].ref.version = "v2";
  expect(f.cover.value).toBeUndefined();
  expect(f.revoke).toHaveBeenCalledOnce();
  await flush();
  const old = owner.value;
  if (!old) throw new Error("No owner");
  expect(old.requests[1].ref.version).toBe("v2");
  owner.value = makeOwner();
  old.requests[1].resolve({
    code: "ok",
    committed: false,
    ref: old.requests[1].ref,
    info: entries.value[0].metadata,
  });
  await flush();
  expect(f.createURL).toHaveBeenCalledOnce();
  await accept(f);
  expect(f.createURL).toHaveBeenCalledTimes(2);
});

it("keeps only the latest song while metadata is pending, clears on dispose and rejects stale refs", async () => {
  const f = fixture();
  await flush();
  const current = owner.value;
  if (!current) throw new Error("No owner");
  entries.value = [entry("B"), entry("C")];
  music.playSong = song("B");
  music.playSong = song("C");
  expect(current.metadata.read).toHaveBeenCalledOnce();
  current.requests[0].resolve({
    code: "ok",
    committed: false,
    ref: current.requests[0].ref,
    info: entry().metadata,
  });
  await flush();
  expect(current.requests[1].ref.fileId).toBe("C");
  current.requests[1].resolve({
    code: "ok",
    committed: false,
    ref: { ...current.requests[1].ref, version: "wrong" },
    info: entry("C").metadata,
  });
  await flush();
  expect(f.createURL).not.toHaveBeenCalled();
  f.stop();
  music.playSong = song("B");
  await flush();
  expect(current.metadata.read).toHaveBeenCalledTimes(2);
});

it("a replacement presentation owner retires the old URL and old cleanup cannot clear the new one", async () => {
  const first = fixture();
  await accept(first);
  const second = fixture();
  expect(first.live.size).toBe(0);
  await accept(second, 1);
  const current = second.cover.value;
  first.stop();
  expect(second.cover.value).toBe(current);
  expect(second.live.size).toBe(1);
  second.stop();
  expect(second.live.size).toBe(0);
});

it("does not enable native artwork on web or electron", () => {
  host.kind = "web";
  expect(createShellLocalArtworkSession()).toBeUndefined();
  host.kind = "electron";
  expect(createShellLocalArtworkSession()).toBeUndefined();
});

it("refreshes a changed same-name sidecar after a same-ref rescan and revokes the old URL", async () => {
  const f = fixture();
  await accept(f);
  const source = owner.value!;
  const previous = entries.value[0];
  entries.value = [{ ...previous, ref: { ...previous.ref } }];
  expect(f.cover.value).toBeUndefined();
  expect(f.revoke).toHaveBeenCalledWith("blob:cover-1");
  await flush();
  expect(source.metadata.read).toHaveBeenCalledTimes(2);
  expect(source.requests[1].ref).toEqual(source.requests[0].ref);
  await accept(f, 1);
  expect(f.cover.value).toBe("blob:cover-2");
  source.directories.value = [
    ...source.directories.value,
    { token: "unrelated", epoch: 1, displayPath: "other" },
  ];
  await flush();
  expect(source.metadata.read).toHaveBeenCalledTimes(2);
  expect(f.revoke).toHaveBeenCalledOnce();
});

it("discovers a newly added same-name sidecar after a same-ref rescan with no previous image", async () => {
  const f = fixture();
  await flush();
  const source = owner.value!;
  const previous = entries.value[0];
  source.requests[0].resolve({
    code: "ok",
    committed: false,
    ref: source.requests[0].ref,
    info: { ...previous.metadata, Pictures: [] },
  });
  await flush();
  expect(f.cover.value).toBeUndefined();
  expect(f.createURL).not.toHaveBeenCalled();
  entries.value = [{ ...previous, ref: { ...previous.ref } }];
  await accept(f, 1);
  expect(source.metadata.read).toHaveBeenCalledTimes(2);
  expect(f.cover.value).toBe("blob:cover-1");
});

it("fences an old same-ref pending read and displays only the latest scan entry", async () => {
  const f = fixture();
  await flush();
  const source = owner.value!;
  const previous = entries.value[0];
  entries.value = [{ ...previous, ref: { ...previous.ref } }];
  await flush();
  // LocalArtworkSession waits for the actual prior read before pumping its latest target.
  expect(source.metadata.read).toHaveBeenCalledOnce();
  source.requests[0].resolve({
    code: "ok",
    committed: false,
    ref: source.requests[0].ref,
    info: previous.metadata,
  });
  await flush();
  expect(f.createURL).not.toHaveBeenCalled();
  expect(source.metadata.read).toHaveBeenCalledTimes(2);
  await accept(f, 1);
  expect(f.cover.value).toBe("blob:cover-1");
});

it("does not reuse a prior entry's shared pending read or overwrite a fresh sidecar with its late result", async () => {
  const source = owner.value!;
  const previous = entries.value[0];
  const old = readLocalDisplay(source, previous.ref, "artwork", previous);
  await flush();
  entries.value = [{ ...previous, ref: { ...previous.ref } }];
  const f = fixture();
  await flush();
  expect(source.metadata.read).toHaveBeenCalledTimes(2);
  await accept(f, 1);
  expect(f.cover.value).toBe("blob:cover-1");
  source.requests[0].resolve({
    code: "ok",
    committed: false,
    ref: previous.ref,
    info: previous.metadata,
  });
  expect(await old).toBeUndefined();
  await flush();
  expect(f.cover.value).toBe("blob:cover-1");
  expect(f.createURL).toHaveBeenCalledOnce();
  expect(f.revoke).not.toHaveBeenCalled();
});
