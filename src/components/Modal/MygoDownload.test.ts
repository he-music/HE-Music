import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { createMygoDownloadResolver } from "../../utils/localDownloadResolver";
import { defaultGrantIndex } from "@/platform/localDownloadOptions";
import { audioOutputFormat } from "@/platform/audioSource";
const settings = Vue.reactive({ downloadPath: "Music one" });
const openSettings = vi.fn();
const success = vi.fn();
vi.mock("@/api/song", () => ({ songDetail: vi.fn(), songLyric: vi.fn(), songUrl: vi.fn() }));
import {
  LocalDownloadSession,
  validDownloadFilename,
  localDownloadSource,
  type LocalDownloadAccess,
} from "../../platform/localDownloadSession";
import { validLocalDownloadFormat } from "../../platform/localDownloadPersistence";
import type { DownloadState, DirectoryGrant } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";
type Element = {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: Element[];
  parent: Element | null;
};
const node = (tag: string, text = ""): Element => ({
  tag,
  text,
  props: {},
  children: [],
  parent: null,
});
const cleanups: Array<() => void> = [];
let session: LocalDownloadSession;
const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
  await Vue.nextTick();
};
afterEach(async () => {
  cleanups.splice(0).forEach((close) => close());
  session?.dispose();
  await vi.advanceTimersByTimeAsync(3001);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(props: object) {
  const { descriptor } = parse(
    readFileSync(new URL("./MygoDownload.vue", import.meta.url), "utf8"),
  );
  const script = compileScript(descriptor, { id: "MygoDownload.vue", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pass = Vue.defineComponent({
    setup(_props, { attrs, slots }) {
      return () => Vue.h("stub", attrs, slots.default?.());
    },
  });
  const modules: Record<string, unknown> = {
    "@/utils/modal": { openSetting: openSettings },
    "@/utils/helper": { formatFileSize: (bytes: number) => `${bytes} B` },
    "@/platform/localDownloadPersistence": { validLocalDownloadFormat },
    "@/platform/audioSource": { audioOutputFormat },
    vue: Vue,
    "vue-i18n": {
      useI18n: () => ({
        t: (key: string, data?: { version?: string }) =>
          data?.version ? `${key}:${data.version}` : key,
      }),
    },
    "@/platform/localDownloadSession": {
      LocalDownloadSession,
      validDownloadFilename,
      localDownloadSource,
    },
    "@/platform/localDownloadOptions": {
      createLocalDownloadPlan: (song: SongInfo) => ({
        filenameStem: song.name,
        options: {
          writeMetadata: true,
          writeCover: true,
          writeLyrics: true,
          saveSidecars: false,
          metadata: {
            title: song.name,
            artists: ["Artist"],
            album: "Album",
            lyrics: "",
            coverURL: "https://img.test/cover",
          },
        },
        resolveOptions: { writeLyricTranslation: true, writeLyricRomaji: true },
      }),
      defaultGrantIndex,
      normalizePortableFilename: (stem: string, format: string) => `${stem}.${format}`,
    },
    "@/stores": {
      usePlatformStore: () => ({
        getPlatformQualityDescription: (_platform: string, name: string) => name,
      }),
      useSettingStore: () => ({
        get downloadPath() {
          return settings.downloadPath;
        },
        fileNameFormat: "title",
        folderStrategy: "none",
        downloadMeta: true,
        downloadCover: true,
        downloadLyric: true,
        downloadLyricTran: true,
        downloadLyricRoma: true,
        saveMetaFile: false,
        showLocalCover: true,
      }),
    },
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected update component import ${name}`);
    return modules[name];
  }, exports);
  const renderer = Vue.createRenderer<Element, Element>({
    createElement: (tag) => node(tag),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    insert(child, parent, anchor) {
      if (child.parent) {
        const old = child.parent.children.indexOf(child);
        if (old >= 0) child.parent.children.splice(old, 1);
      }
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
      child.parent = parent;
    },
    remove(child) {
      const index = child.parent?.children.indexOf(child) ?? -1;
      if (index >= 0) child.parent?.children.splice(index, 1);
      child.parent = null;
    },
    setText(target, text) {
      target.text = text;
    },
    setElementText(target, text) {
      target.text = text;
      target.children = [];
    },
    patchProp(target, key, _old, value) {
      target.props[key] = value;
    },
    parentNode: (target) => target.parent,
    nextSibling(target) {
      const siblings = target.parent?.children ?? [];
      return siblings[siblings.indexOf(target) + 1] ?? null;
    },
  });
  if (!exports.default) throw new Error("Missing compiled update component");
  const component = exports.default;
  const app = renderer.createApp({ setup: () => () => Vue.h(component, props) });
  for (const name of [
    "NSelect",
    "NInput",
    "NButton",
    "NRadioGroup",
    "NRadio",
    "NFlex",
    "NText",
    "NCollapse",
    "NCollapseItem",
    "NInputGroup",
    "NAlert",
    "SvgIcon",
    "SongDataCard",
  ])
    app.component(name, pass);
  const root = node("root");
  app.mount(root);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      app.unmount();
    }
  };
  cleanups.push(close);
  const all = (target = root): Element[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  const text = (element: Element): string => element.text + element.children.map(text).join("");
  const button = (key: string) => {
    const found = all().find(
      (element) => typeof element.props.onClick === "function" && text(element).trim() === key,
    );
    if (!found) throw new Error(`Missing button ${key}`);
    return found;
  };
  return {
    all,
    text: () => text(root),
    close,
    button,
    click: (key: string) => {
      const action = button(key).props.onClick;
      if (typeof action !== "function") throw new Error("Missing action");
      return action();
    },
  };
}

const song: SongInfo = {
  id: "song",
  name: "Song",
  subtitle: "",
  duration: 1,
  mv_id: "",
  album: "",
  platform: "test",
  cover: "",
  links: [
    { name: "320mp3", quality: 320, format: "mp3", size: "1", url: "" },
    { name: "lossless", quality: 999, format: "flac", size: "2", url: "" },
    { name: "other", quality: 1, format: "aac", size: "1", url: "" },
  ],
};
const grants: DirectoryGrant[] = [
  { token: "private-grant-one", epoch: 1, displayPath: "Music one" },
  { token: "private-grant-two", epoch: 1, displayPath: "Music two" },
];
let access: LocalDownloadAccess;
let snapshot: Partial<DownloadState>;
beforeEach(() => {
  settings.downloadPath = "Music one";
  openSettings.mockClear();
  success.mockClear();
  vi.stubGlobal("window", { $message: { success } });
  vi.useFakeTimers();
  snapshot = {};
  access = {
    current: () => true,
    start: vi.fn(async (request) => ({ operationId: request.operationId })),
    read: vi.fn(async (id) => ({
      operationId: id,
      code: "running",
      done: false,
      received: 0,
      total: 0,
      committed: false,
      ...snapshot,
    })),
    cancel: vi.fn(async (id) => ({
      operationId: id,
      code: "cancelled",
      done: false,
      received: 0,
      total: 0,
      committed: false,
    })),
  };
  session = new LocalDownloadSession({ access: () => access, onCommitted: async () => {} });
});
const change = (element: Element, value: unknown) => {
  const handler = element.props["onUpdate:value"];
  if (typeof handler !== "function") throw new Error("Missing update handler");
  handler(value);
};
const controls = (view: ReturnType<typeof mount>) =>
  ["directory", "quality"].map((field) => {
    const control = view.all().find((element) => element.props["data-download-field"] === field);
    if (!control) throw new Error(`Missing download field ${field}`);
    return control;
  });

it("mounts the actual SFC, reads the configured grant, links to settings and freshly resolves quality", async () => {
  settings.downloadPath = "Music two";
  const chooseDirectory = vi.fn(async () => {});
  const resolveURL = vi.fn(async () => ({
    url: "https://example.test/audio?SIGNED",
    format: "flac",
  }));
  const view = mount({ song, session, grants, chooseDirectory, resolveURL });
  await flush();
  const [directory, quality] = controls(view);
  expect(directory.props.value).toBe("Music two");
  expect(directory.props.disabled).toBe(true);
  expect(quality.props.name).toBe("level");
  expect(view.all().filter((element) => element.props.value === "lossless")).toHaveLength(1);
  change(quality, "lossless");
  await flush();
  await view.click("setting.local.download_config");
  expect(openSettings).toHaveBeenCalledWith("local");
  expect(chooseDirectory).not.toHaveBeenCalled();
  await view.click("download.add");
  await flush();
  expect(resolveURL).toHaveBeenCalledWith(
    "lossless",
    localDownloadSource(song),
    expect.any(Object),
    expect.any(Object),
  );
  expect(access.start).toHaveBeenCalledWith(
    expect.objectContaining({
      grantToken: grants[1].token,
      filename: "Song.flac",
      url: "https://example.test/audio?SIGNED",
    }),
  );
  expect(view.text()).not.toMatch(/SIGNED|private-grant|https|operationId/);
  await view.click("download.add");
  await flush();
  expect(access.start).toHaveBeenCalledTimes(1);
  expect(view.text()).not.toContain("local_download.start_rejected");
  expect(view.all().filter((element) => typeof element.props.onClick === "function")).toHaveLength(
    3,
  );
});

it("uses the original quality preference and leaves a missing default directory unselected", async () => {
  const resolveURL = vi.fn(async () => ({ url: "https://example.test/audio", format: "mp3" }));
  settings.downloadPath = "missing";
  const props = Vue.shallowReactive({
    song,
    session,
    grants,
    chooseDirectory: vi.fn(),
    resolveURL,
  });
  const view = mount(props);
  expect(controls(view)[1].props.value).toBe("320mp3");
  expect(view.button("download.add").props.disabled).toBe(true);
  await view.click("download.add");
  expect(resolveURL).not.toHaveBeenCalled();
  expect(access.start).not.toHaveBeenCalled();
  settings.downloadPath = "Music two";
  await flush();
  expect(view.button("download.add").props.disabled).toBe(false);
  props.song = { ...song, links: song.links.filter((link) => link.name !== "320mp3") };
  await flush();
  expect(controls(view)[1].props.value).toBe("other");
});
it("derives the filename from the current song when its quality links are reused", async () => {
  const props = Vue.shallowReactive({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: async () => ({ url: "https://example.test/audio", format: "mp3" }),
  });
  const view = mount(props);
  props.song = { ...song, id: "other-song", name: "Another song" };
  await flush();
  await view.click("download.add");
  expect(access.start).toHaveBeenCalledWith(
    expect.objectContaining({ filename: "Another song.mp3" }),
  );
});

it("only adds a task and closes, leaving progress and retries to the manager", async () => {
  const resolveURL = vi.fn(async () => ({ url: "https://example.test/audio", format: "mp3" }));
  const onClose = vi.fn();
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL,
    onClose,
  });
  await view.click("download.add");
  await flush();
  expect(onClose).toHaveBeenCalledOnce();
  expect(success).toHaveBeenCalledWith("message.download_added");
  const id = session.tasks.value[0].id;
  snapshot = { received: 5, total: 0 };
  await session.refresh(id);
  await flush();
  expect(session.tasks.value[0].received).toBe(5);
  expect(view.text()).not.toContain("local_download.unknown_size");
  snapshot = { received: 10, total: 10, done: true, code: "network_error" };
  await session.refresh(id);
  await flush();
  expect(session.tasks.value[0].retryable).toBe(true);
  expect(view.text()).not.toMatch(
    /local_download\.(retry|refresh|phase_|confirm_retry)|download\.download_manager/,
  );
  expect(() => view.button("local_download.retry")).toThrow();
  expect(() => view.button("local_download.cancel")).toThrow();
  expect(resolveURL).toHaveBeenCalledOnce();
  view.close();
  expect(session.tasks.value).toHaveLength(1);
});

it("reacts to grant props, rejects mismatched formats, and prevents a revoked pending URL from starting", async () => {
  let finish!: (result: { url: string; format: string }) => void;
  const resolveURL = vi.fn(
    () =>
      new Promise<{ url: string; format: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const properties = Vue.shallowReactive({
    song,
    session,
    grants: [] as readonly DirectoryGrant[],
    chooseDirectory: vi.fn(async () => {}),
    resolveURL,
  });
  // A host wrapper propagates reactive parent prop changes to the mounted SFC.
  const view = mount(properties);
  expect(view.button("download.add").props.disabled).toBe(true);
  await view.click("setting.local.download_config");
  expect(openSettings).toHaveBeenCalledWith("local");
  expect(properties.chooseDirectory).not.toHaveBeenCalled();
  properties.grants = grants;
  await flush();
  expect(view.button("download.add").props.disabled).toBe(false);
  const pending = view.click("download.add");
  await flush();
  properties.grants = [];
  await flush();
  finish({ url: "https://example.test/audio", format: "mp3" });
  await pending;
  expect(access.start).not.toHaveBeenCalled();
  const mismatch = mount({
    ...properties,
    grants,
    resolveURL: async () => ({ url: "https://example.test/audio", format: "flac" }),
  });
  await mismatch.click("download.add");
  await flush();
  expect(mismatch.text()).toContain("local_download.operation_failed");
  expect(access.start).not.toHaveBeenCalled();
});

it("leaves committed warnings and scan failure in the queue after closing", async () => {
  session.dispose();
  session = new LocalDownloadSession({
    access: () => access,
    onCommitted: async () => {
      throw new Error("private error");
    },
  });
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: async () => ({ url: "https://example.test/audio", format: "mp3" }),
  });
  await view.click("download.add");
  await session.cancel(session.tasks.value[0].id);
  await flush();
  expect(access.cancel).toHaveBeenCalledWith(session.tasks.value[0].id);
  expect(session.tasks.value[0].done).toBe(false);
  snapshot = {
    done: true,
    code: "sync_failed",
    committed: true,
    filename: "Song.mp3",
    ref: { grantToken: grants[0].token, relativePath: "Song.mp3", fileId: "fresh", version: "v1" },
  };
  await session.refresh(session.tasks.value[0].id);
  await flush();
  expect(session.tasks.value[0]).toMatchObject({
    phase: "saved",
    refresh: "failed",
    warning: "sync_failed",
    retryable: false,
  });
  expect(view.text()).not.toMatch(/local_download\.(possibly_saved|refresh_failed|warning|retry)/);
  const source = readFileSync(new URL("./MygoDownload.vue", import.meta.url), "utf8");
  expect(source).not.toMatch(/window\.electron|electron|file-saver|localStorage|dataStore/);
});

it.each(["quality", "grant"])("discards pending URL after changing %s", async (field) => {
  let finish!: (value: { url: string; format: string }) => void;
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = view.click("download.add");
  await flush();
  const [directory, quality] = controls(view);
  expect([directory, quality].every((control) => control.props.disabled === true)).toBe(true);
  if (field === "quality") change(quality, "lossless");
  if (field === "grant") settings.downloadPath = "Music two";
  await flush();
  finish({ url: "https://example.test/old", format: "mp3" });
  await pending;
  expect(access.start).not.toHaveBeenCalled();
  await flush();
  expect(controls(view)[0].props.disabled).toBe(true);
  expect(controls(view)[1].props.disabled).toBe(false);
});

it("retries original A after closing its modal and opening unrelated B", async () => {
  const resolveA = vi.fn(async () => ({
    url: `https://example.test/A/${resolveA.mock.calls.length}`,
    format: "mp3",
  }));
  const first = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: resolveA,
  });
  await first.click("download.add");
  const id = session.tasks.value[0].id;
  snapshot = { done: true, code: "network_error" };
  await session.refresh(id);
  first.close();
  const songB = { ...song, id: "B", name: "Other song", platform: "other" };
  const resolveB = vi.fn(async () => ({ url: "https://example.test/B", format: "flac" }));
  const second = mount({
    song: songB,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: resolveB,
  });
  const [, quality] = controls(second);
  settings.downloadPath = "Music two";
  change(quality, "lossless");
  await flush();
  expect(() => second.button("local_download.retry")).toThrow();
  await session.retry(id);
  await flush();
  expect(resolveB).not.toHaveBeenCalled();
  expect(resolveA).toHaveBeenCalledTimes(2);
  expect(resolveA).toHaveBeenLastCalledWith(
    "320mp3",
    localDownloadSource(song),
    expect.any(Object),
    expect.any(Object),
  );
  const source = vi.mocked(resolveA).mock.calls[1];
  expect(JSON.stringify(source)).not.toContain('"url":');
  expect(access.start).toHaveBeenLastCalledWith(
    expect.objectContaining({ filename: "Song.mp3", grantToken: grants[0].token }),
  );
  expect(session.tasks.value[1].label).toBe("Song");
  expect(session.tasks.value[1].id).not.toBe(id);
});

it.each(["song", "resolver", "session", "closed"])(
  "never sends an old resolver result after %s changes",
  async (field) => {
    let finish!: (value: { url: string; format: string }) => void;
    const properties = Vue.shallowReactive({
      song,
      session,
      grants,
      chooseDirectory: async () => {},
      resolveURL: () =>
        new Promise<{ url: string; format: string }>((resolve) => {
          finish = resolve;
        }),
    });
    const view = mount(properties);
    const pending = view.click("download.add");
    await flush();
    let replacement: LocalDownloadSession | undefined;
    if (field === "song") properties.song = { ...song, id: "B", name: "B" };
    if (field === "resolver")
      properties.resolveURL = async () => ({ url: "https://example.test/new", format: "mp3" });
    if (field === "session") {
      replacement = new LocalDownloadSession({ access: () => access, onCommitted: async () => {} });
      properties.session = replacement;
    }
    if (field === "closed") view.close();
    await flush();
    finish({ url: "https://example.test/old", format: "mp3" });
    await pending;
    expect(access.start).not.toHaveBeenCalled();
    replacement?.dispose();
  },
);

it("invalidates even a reverted quality edit during URL resolution", async () => {
  let finish!: (value: { url: string; format: string }) => void;
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = view.click("download.add");
  await flush();
  const quality = controls(view)[1];
  change(quality, "lossless");
  change(quality, "320mp3");
  finish({ url: "https://example.test/old", format: "mp3" });
  await pending;
  expect(access.start).not.toHaveBeenCalled();
});

it("cancel closes the add dialog and invalidates a pending resolver without cancelling queued tasks", async () => {
  let finish!: (value: { url: string; format: string }) => void;
  const onClose = vi.fn();
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    onClose,
    resolveURL: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = view.click("download.add");
  await flush();
  await view.click("common.cancel");
  expect(onClose).toHaveBeenCalledOnce();
  finish({ url: "https://example.test/stale", format: "mp3" });
  await pending;
  expect(access.start).not.toHaveBeenCalled();
  expect(access.cancel).not.toHaveBeenCalled();
  expect(session.tasks.value).toEqual([]);
});

it.each([
  "file:///unsafe.jpg",
  "https://%65xample.com/cover.jpg",
  "http:opaque",
  "https://user:pass@img.test/c",
  "https://img.test/c#fragment",
])("actual SFC and resolver reject invalid cover before native Start: %s", async (cover) => {
  const resolveURL = createMygoDownloadResolver(
    async () => ({ url: "https://cdn.test/audio", format: "mp3" }),
    async () => ({ song: { ...song, cover } }),
    async () => ({ lyric: "line" }),
  );
  const view = mount({ song, session, grants, chooseDirectory: async () => {}, resolveURL });
  await view.click("download.add");
  await flush();
  expect(access.start).not.toHaveBeenCalled();
  expect(session.tasks.value).toEqual([]);
  expect(view.text()).toContain("local_download.operation_failed");
});
