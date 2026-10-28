import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderer, defineComponent, h, nextTick, shallowRef, watch, type VNode } from "vue";
import type { ModalOptions } from "naive-ui";
import type { SongInfo } from "@/types/main.hemusic";
import type { DirectoryGrant, ScanEntry } from "@/platform/mygo.bindings";
import { LocalMetadataSession } from "@/platform/localMetadataSession";
import { LocalDownloadSession, localDownloadSource } from "@/platform/localDownloadSession";

vi.mock("@/api/song", () => ({ songUrl: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import {
  createMygoFileModals,
  createMygoDownloadResolver,
  type MygoModalOwner,
} from "./mygoFileModals";

const grant = (token = "grant"): DirectoryGrant => ({ token, epoch: 1, displayPath: "Music" });
const song: SongInfo = {
  id: "mygo-local:file",
  platform: "local",
  path: "song.mp3",
  name: "Song",
  subtitle: "",
  artists: "Artist",
  album: "Album",
  duration: 10,
  size: 10,
  mv_id: "",
  cover: "",
  links: [{ name: "MP3", quality: 320, format: "mp3", size: "10", url: "https://unused.invalid" }],
};
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const component = { default: defineComponent(() => () => h("div")) };
function fixture() {
  function makeOwner() {
    const ready = shallowRef(true);
    const directories = shallowRef<readonly DirectoryGrant[]>([grant()]);
    const metadata = new LocalMetadataSession({
      access: () => undefined,
      blockAudio: () => () => {},
      refreshLibrary: async () => {},
    });
    const downloads = new LocalDownloadSession({
      access: (token) =>
        directories.value.some((g) => g.token === token)
          ? {
              current: () => ready.value && directories.value.some((g) => g.token === token),
              start: async (request) => ({ operationId: request.operationId }),
              read: async (id) => ({
                operationId: id,
                code: "running",
                done: false,
                committed: false,
                received: 0,
                total: 0,
                filename: "song.mp3",
              }),
              cancel: async (id) => ({
                operationId: id,
                code: "cancelled",
                done: true,
                committed: false,
                received: 0,
                total: 0,
                filename: "song.mp3",
              }),
            }
          : undefined,
      onCommitted: async () => {},
    });
    cleanups.push(
      () => metadata.dispose(),
      () => downloads.dispose(),
    );
    return {
      ready,
      directories,
      metadata,
      downloads,
      chooseDirectory: vi.fn<MygoModalOwner["chooseDirectory"]>(async () => ({
        status: "completed",
        value: { status: "cancelled", grant: null, relation: "", existingToken: "" },
      })),
      metadataAccess: (ref: ScanEntry["ref"]) => ({
        current: () =>
          ready.value && directories.value.some((g) => g.token === ref.grantToken && g.epoch === 1),
        read: async () => ({ code: "unsupported", committed: false }),
        save: async () => ({ code: "unsupported", committed: false }),
        cancel: async () => ({ code: "unsupported", committed: false }),
      }),
    };
  }
  const first = makeOwner();
  const owner = shallowRef<MygoModalOwner | undefined>(first);
  const entry = shallowRef<ScanEntry | undefined>({
    ref: { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "version" },
    relativePath: "song.mp3",
    filename: "song.mp3",
    size: 10,
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
      DurationSeconds: 10,
      BitrateKbps: 320,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 0,
      Codec: "mp3",
    },
  });
  const loadEditor = vi.fn<() => Promise<{ default: import("vue").Component }>>(
    async () => component,
  );
  const loadDownload = vi.fn<() => Promise<{ default: import("vue").Component }>>(
    async () => component,
  );
  const created: Array<{ options: ModalOptions; destroy: ReturnType<typeof vi.fn> }> = [];
  const warn = vi.fn();
  const api = createMygoFileModals({
    owner,
    entry: (id) => (id === song.id ? entry.value : undefined),
    loadEditor,
    loadDownload,
    warn,
    translate: (key) => key,
    resolveURL: createMygoDownloadResolver(vi.fn()),
    create: (options) => {
      const destroy = vi.fn(() => {
        options.onAfterLeave?.();
      });
      created.push({ options, destroy });
      return { destroy };
    },
  });
  cleanups.push(() => {
    owner.value = undefined;
  });
  return { api, owner, first, entry, loadEditor, loadDownload, created, warn, makeOwner };
}
function props(options: ModalOptions) {
  if (typeof options.content !== "function") throw new Error("Expected content renderer");
  return (options.content() as VNode).props!;
}

describe("pending component loading", () => {
  it.each(["owner", "ready", "grant", "entry"])(
    "never creates an editor after %s invalidation",
    async (cause) => {
      const f = fixture();
      const pending = deferred<typeof component>();
      f.loadEditor.mockReturnValueOnce(pending.promise);
      const opening = f.api.openMygoSongInfoEditor(song);
      if (cause === "owner") f.owner.value = f.makeOwner();
      if (cause === "ready") f.first.ready.value = false;
      if (cause === "grant") f.first.directories.value = [];
      if (cause === "entry") f.entry.value = undefined;
      pending.resolve(component);
      await opening;
      expect(f.created).toHaveLength(0);
    },
  );
  it.each(["editor", "download"])(
    "allows a new owner to take over a pending %s import",
    async (kind) => {
      const f = fixture();
      const pending = deferred<typeof component>();
      const open = kind === "editor" ? f.api.openMygoSongInfoEditor : f.api.openMygoDownloadSong;
      (kind === "editor" ? f.loadEditor : f.loadDownload).mockReturnValueOnce(pending.promise);
      const old = open(song);
      const next = f.makeOwner();
      f.owner.value = next;
      await open(song);
      pending.resolve(component);
      await old;
      expect(f.created).toHaveLength(1);
      expect(props(f.created[0].options).session).toBe(
        kind === "editor" ? next.metadata : next.downloads,
      );
    },
  );
  it("deduplicates calls while importing, and recovers after a loader failure without details", async () => {
    const f = fixture();
    const pending = deferred<typeof component>();
    f.loadEditor.mockReturnValueOnce(pending.promise);
    const old = f.api.openMygoSongInfoEditor(song);
    await f.api.openMygoSongInfoEditor(song);
    expect(f.loadEditor).toHaveBeenCalledTimes(1);
    pending.reject(new Error("https://secret.invalid/?token=private"));
    await old;
    expect(f.warn).toHaveBeenCalledWith("local_metadata.unavailable");
    await f.api.openMygoSongInfoEditor(song);
    expect(f.created).toHaveLength(1);
  });
});

it("rejects stale song id, path, platform and inconsistent registry ref", async () => {
  const f = fixture();
  for (const changed of [{ id: "other" }, { path: "other.mp3" }, { platform: "online" }]) {
    await f.api.openMygoSongInfoEditor({ ...song, ...changed });
  }
  f.entry.value = { ...f.entry.value!, ref: { ...f.entry.value!.ref, relativePath: "other.mp3" } };
  await f.api.openMygoSongInfoEditor(song);
  expect(f.loadEditor).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledWith("local_metadata.entry_changed");
});

it("adding unrelated grants preserves both views; removing editor grant closes only editor synchronously", async () => {
  const f = fixture();
  await f.api.openMygoSongInfoEditor(song);
  await f.api.openMygoDownloadSong(song);
  f.first.directories.value = [grant(), grant("other")];
  expect(f.created.every((view) => !view.destroy.mock.calls.length)).toBe(true);
  f.first.directories.value = [grant("other")];
  expect(f.created[0].destroy).toHaveBeenCalledTimes(1);
  expect(f.created[1].destroy).not.toHaveBeenCalled();
  expect(props(f.created[1].options).grants).toEqual([grant("other")]);
  f.first.ready.value = false;
  expect(f.created[1].destroy).toHaveBeenCalledTimes(1);
});

it.each(["close", "X", "show", "afterLeave"])(
  "%s releases watches without destroying or cancelling session tasks",
  async (how) => {
    const f = fixture();
    const dispose = vi.spyOn(f.first.downloads, "dispose");
    const cancel = vi.spyOn(f.first.downloads, "cancel");
    await f.api.openMygoDownloadSong(song);
    const view = f.created[0];
    if (how === "close") props(view.options).onClose();
    if (how === "X" && typeof view.options.onClose === "function") view.options.onClose();
    if (how === "show" && typeof view.options.onUpdateShow === "function")
      view.options.onUpdateShow(false);
    if (how === "afterLeave") view.options.onAfterLeave?.();
    const calls = view.destroy.mock.calls.length;
    f.first.ready.value = false;
    expect(view.destroy).toHaveBeenCalledTimes(calls);
    expect(dispose).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(f.owner.value?.downloads).toBe(f.first.downloads);
    f.first.ready.value = true;
    await f.api.openMygoDownloadSong(song);
    expect(f.created).toHaveLength(2);
  },
);

it("keeps an active original task across modal close, another grant invalidation and reopening", async () => {
  const f = fixture();
  const id = await f.first.downloads.start({
    grantToken: "grant",
    filename: "song.mp3",
    label: "Song",
    quality: "MP3",
    source: localDownloadSource(song),
    resolveURL: createMygoDownloadResolver(vi.fn()),
    url: "https://example.invalid/audio",
  });
  expect(id).toBeTruthy();
  await f.api.openMygoDownloadSong(song);
  props(f.created[0].options).onClose();
  f.first.downloads.invalidate("other");
  expect(f.first.downloads.tasks.value).toHaveLength(1);
  expect(f.first.downloads.tasks.value[0].id).toBe(id);
  await f.api.openMygoDownloadSong({ ...song, id: "new-online", platform: "service" });
  expect(props(f.created[1].options).session).toBe(f.first.downloads);
  expect(f.first.downloads.tasks.value[0].phase).toBe("active");
});

it("does not open the picker until its injected user action and ignores stale callbacks", async () => {
  const f = fixture();
  await f.api.openMygoDownloadSong(song);
  expect(f.first.chooseDirectory).not.toHaveBeenCalled();
  const action = props(f.created[0].options).chooseDirectory;
  await action();
  expect(f.first.chooseDirectory).toHaveBeenCalledTimes(1);
  props(f.created[0].options).onClose();
  await action();
  expect(f.first.chooseDirectory).toHaveBeenCalledTimes(1);
});

it("updates download grants through a Vue runtime stub host without remounting its component", async () => {
  const f = fixture();
  const mounted = vi.fn();
  const observed: unknown[] = [];
  f.loadDownload.mockResolvedValue({
    default: defineComponent({
      props: ["grants"],
      setup(p) {
        mounted();
        watch(
          () => p.grants,
          (value) => observed.push(value),
          { immediate: true },
        );
        return () => h("div");
      },
    }),
  });
  await f.api.openMygoDownloadSong(song);
  const renderer = createRenderer<object, object>({
    patchProp: () => {},
    insert: () => {},
    remove: () => {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp(
    defineComponent(() => () => {
      const content = f.created[0].options.content;
      return typeof content === "function" ? content() : null;
    }),
  );
  app.mount({});
  cleanups.push(() => app.unmount());
  f.first.directories.value = [grant(), grant("second")];
  await nextTick();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(observed).toEqual([[grant()], [grant(), grant("second")]]);
});

describe("fresh URL resolver", () => {
  it.each(["mp3", "flac"])(
    "uses frozen original source and numeric quality for %s on every request",
    async (format) => {
      const original = localDownloadSource({
        ...song,
        id: "original",
        platform: "service",
        links: [{ name: "Lossless", format, quality: 999, size: "10" }],
      });
      const request = vi.fn().mockResolvedValue({
        url: "https://example.invalid/new?signature=private",
        format: format.toUpperCase(),
      });
      const resolve = createMygoDownloadResolver(request);
      await resolve("Lossless", original);
      await resolve("Lossless", original);
      expect(request).toHaveBeenNthCalledWith(1, "original", "service", 999, format);
      expect(request).toHaveBeenNthCalledWith(2, "original", "service", 999, format);
      expect(Object.isFrozen(original.links[0])).toBe(true);
    },
  );
  it.each(["missing", "aac"])(
    "rejects unsupported quality %s before requesting",
    async (quality) => {
      const request = vi.fn();
      const resolve = createMygoDownloadResolver(request);
      const source = localDownloadSource({
        ...song,
        links: [...song.links, { name: "aac", format: "aac", quality: 1, size: "1" }],
      });
      await expect(resolve(quality, source)).rejects.toThrow("Download source unavailable");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { format: "flac" },
    { format: "aac" },
    { format: "mp3", url: "file:///private/song.mp3" },
    { format: "mp3", url: "https://user:secret@example.invalid/audio" },
  ])(
    "rejects mismatched/missing formats and unsafe URL without exposing response",
    async (response) => {
      const request = vi
        .fn()
        .mockResolvedValue({ url: "https://example.invalid/?token=secret", ...response });
      const resolve = createMygoDownloadResolver(request);
      await expect(resolve("MP3", localDownloadSource(song))).rejects.toThrow(
        /^Download source unavailable$/,
      );
    },
  );
  it("strips thrown API details including signed URL", async () => {
    const resolve = createMygoDownloadResolver(
      vi
        .fn()
        .mockRejectedValue(new Error("https://example.invalid/?token=secret /private/library")),
    );
    await expect(resolve("MP3", localDownloadSource(song))).rejects.toThrow(
      /^Download source unavailable$/,
    );
  });
});
