import { afterEach, expect, it, vi } from "vitest";
import { defineComponent, shallowRef } from "vue";
import type { ModalOptions } from "naive-ui";
import { LocalMetadataSession } from "@/platform/localMetadataSession";
import type { DirectoryGrant, ScanEntry } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

vi.mock("@/api/song", () => ({ songUrl: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { createMygoFileModals, type MygoModalOwner } from "./mygoFileModals";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const grant = (token: string): DirectoryGrant => ({ token, epoch: 1, displayPath: "Music" });
const song: SongInfo = {
  id: "mygo-local:file",
  platform: "local",
  path: "song.mp3",
  name: "Song",
  subtitle: "",
  artists: "",
  album: "",
  duration: 0,
  size: 0,
  mv_id: "",
  cover: "",
  links: [],
};

function fixture() {
  const ready = shallowRef(true);
  const directories = shallowRef<readonly DirectoryGrant[]>([grant("grant")]);
  const metadata = new LocalMetadataSession({
    access: () => undefined,
    blockAudio: () => () => {},
    refreshLibrary: async () => {},
  });
  const dispose = vi.spyOn(metadata, "dispose");
  const invalidate = vi.spyOn(metadata, "invalidate");
  const owner = shallowRef<MygoModalOwner | undefined>({
    ready,
    directories,
    metadata,
    chooseDirectory: async () => ({ status: "unavailable" }),
    metadataAccess: () => ({
      current: () =>
        ready.value && directories.value.some((g) => g.token === "grant" && g.epoch === 1),
      read: async () => ({ code: "unsupported", committed: false }),
      save: async () => ({ code: "unsupported", committed: false }),
      cancel: async () => ({ code: "unsupported", committed: false }),
    }),
  });
  const entry = shallowRef<ScanEntry | undefined>({
    ref: { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "v1" },
    relativePath: "song.mp3",
    filename: "song.mp3",
    size: 0,
    metadata: {
      Container: "mp3",
      Title: "",
      Artists: [],
      Album: "",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      DurationSeconds: 0,
      BitrateKbps: 0,
      SampleRateHz: 0,
      Channels: 0,
      BitsPerSample: 0,
      Codec: "mp3",
    },
  });
  let options: ModalOptions | undefined;
  const destroy = vi.fn(() => options?.onAfterLeave?.());
  const load = async () => ({ default: defineComponent(() => () => null) });
  const api = createMygoFileModals({
    owner,
    entry: () => entry.value,
    loadEditor: load,
    loadDownload: load,
    create: (value) => {
      options = value;
      return { destroy };
    },
    warn: vi.fn(),
    translate: (key) => key,
    resolveURL: vi.fn(),
  });
  cleanups.push(() => {
    owner.value = undefined;
    metadata.dispose();
  });
  return { api, owner, ready, directories, entry, destroy, dispose, invalidate };
}

it("keeps the open editor through a save registry clear and replacement ref so completion remains visible", async () => {
  const f = fixture();
  await f.api.openMygoSongInfoEditor(song);
  const oldEntry = f.entry.value!;
  f.entry.value = undefined;
  expect(f.destroy).not.toHaveBeenCalled();
  f.entry.value = { ...oldEntry, ref: { ...oldEntry.ref, fileId: "renamed-file", version: "v2" } };
  expect(f.destroy).not.toHaveBeenCalled();
  expect(f.dispose).not.toHaveBeenCalled();
  expect(f.invalidate).not.toHaveBeenCalled();
  f.directories.value = [grant("grant"), grant("unrelated")];
  expect(f.destroy).not.toHaveBeenCalled();
  f.directories.value = [grant("unrelated")];
  expect(f.destroy).toHaveBeenCalledTimes(1);
});

it.each(["owner", "ready", "grant"])(
  "still closes the editor synchronously on %s invalidation after registry replacement",
  async (cause) => {
    const f = fixture();
    await f.api.openMygoSongInfoEditor(song);
    f.entry.value = undefined;
    expect(f.destroy).not.toHaveBeenCalled();
    if (cause === "owner") f.owner.value = undefined;
    if (cause === "ready") f.ready.value = false;
    if (cause === "grant") f.directories.value = [];
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled();
  },
);
