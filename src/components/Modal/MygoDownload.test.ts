import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import {
  LocalDownloadSession,
  validDownloadFilename,
  localDownloadSource,
  type LocalDownloadAccess,
} from "@/platform/localDownloadSession";
import { validLocalDownloadFormat } from "@/platform/localDownloadPersistence";
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
    "@/platform/localDownloadPersistence": { validLocalDownloadFormat },
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
  for (const name of ["NSelect", "NInput", "NButton"]) app.component(name, pass);
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
      (element) => typeof element.props.onClick === "function" && text(element) === key,
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
  view.all().filter((element) => "onUpdate:value" in element.props);

it("mounts the actual SFC, chooses grants/quality, edits basename and uses a freshly resolved URL", async () => {
  const chooseDirectory = vi.fn(async () => {});
  const resolveURL = vi.fn(async () => ({
    url: "https://example.test/audio?SIGNED",
    format: "flac",
  }));
  const view = mount({ song, session, grants, chooseDirectory, resolveURL });
  await flush();
  const [directory, quality, name] = controls(view);
  expect(directory.props.options).toEqual(
    grants.map((grant, value) => ({ label: grant.displayPath, value })),
  );
  expect(quality.props.options).toEqual([
    { label: "320mp3", value: "320mp3" },
    { label: "lossless", value: "lossless" },
    { label: "other", value: "other" },
  ]);
  change(directory, 1);
  change(quality, "lossless");
  await flush();
  change(name, "chosen.flac");
  await flush();
  await view.click("local_download.choose_directory");
  expect(chooseDirectory).toHaveBeenCalledTimes(1);
  await view.click("local_download.start");
  await flush();
  expect(resolveURL).toHaveBeenCalledWith("lossless", localDownloadSource(song));
  expect(access.start).toHaveBeenCalledWith(
    expect.objectContaining({
      grantToken: grants[1].token,
      filename: "chosen.flac",
      url: "https://example.test/audio?SIGNED",
    }),
  );
  expect(view.text()).not.toMatch(/SIGNED|private-grant|https|operationId/);
  await view.click("local_download.start");
  await flush();
  expect(access.start).toHaveBeenCalledTimes(1);
  expect(view.text()).toContain("local_download.start_rejected");
});

it("renders real progress, unknown refresh, explicit retry with a new URL/id, and close preserves tasks", async () => {
  const resolveURL = vi.fn(async () => ({
    url: `https://example.test/${resolveURL.mock.calls.length}`,
    format: "mp3",
  }));
  const onClose = vi.fn();
  const view = mount({
    song,
    session,
    grants,
    chooseDirectory: async () => {},
    resolveURL,
    onClose,
  });
  await view.click("local_download.start");
  await flush();
  const id = session.tasks.value[0].id;
  snapshot = { received: 5, total: 0 };
  await session.refresh(id);
  await flush();
  expect(view.text()).toContain("5 / local_download.unknown_size");
  snapshot = { received: 10, total: 10 };
  await session.refresh(id);
  await flush();
  expect(view.text()).toContain("99%");
  vi.mocked(access.read).mockRejectedValueOnce(new Error("signed private error"));
  await session.refresh(id);
  await flush();
  expect(view.text()).toContain("local_download.phase_unknown");
  await view.click("local_download.refresh");
  await flush();
  expect(session.tasks.value[0].phase).toBe("active");
  snapshot = { received: 10, total: 10, done: true, code: "network_error" };
  await session.refresh(id);
  await flush();
  await view.click("local_download.retry");
  await flush();
  expect(resolveURL).toHaveBeenCalledTimes(1);
  expect(view.text()).toContain("local_download.retry_notice");
  await view.click("local_download.confirm_retry");
  await flush();
  expect(resolveURL).toHaveBeenCalledTimes(2);
  const calls = vi.mocked(access.start).mock.calls;
  expect(calls[0][0].operationId).not.toBe(calls[1][0].operationId);
  expect(calls[0][0].url).not.toBe(calls[1][0].url);
  const dispose = vi.spyOn(session, "dispose");
  await view.click("local_download.close");
  view.close();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  expect(session.tasks.value).toHaveLength(2);
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
  expect(view.button("local_download.start").props.disabled).toBe(true);
  await view.click("local_download.choose_directory");
  expect(properties.chooseDirectory).toHaveBeenCalledTimes(1);
  properties.grants = grants;
  await flush();
  expect(view.button("local_download.start").props.disabled).toBe(false);
  const pending = view.click("local_download.start");
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
  await mismatch.click("local_download.start");
  await flush();
  expect(mismatch.text()).toContain("local_download.operation_failed");
  expect(access.start).not.toHaveBeenCalled();
});

it("shows committed cancellation and refresh failure without retry or internal diagnostic codes", async () => {
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
  await view.click("local_download.start");
  await view.click("local_download.cancel");
  await flush();
  expect(access.cancel).toHaveBeenCalledWith(session.tasks.value[0].id);
  expect(session.tasks.value[0].done).toBe(false);
  snapshot = { done: true, code: "sync_failed", committed: true };
  await session.refresh(session.tasks.value[0].id);
  await flush();
  expect(view.text()).toContain("local_download.possibly_saved");
  expect(view.text()).toContain("local_download.phase_saved");
  expect(view.text()).toContain("local_download.refresh_failed");
  expect(view.text()).not.toContain("sync_failed");
  expect(() => view.button("local_download.retry")).toThrow();
  const source = readFileSync(new URL("./MygoDownload.vue", import.meta.url), "utf8");
  expect(source).not.toMatch(/window\.|electron|file-saver|localStorage|dataStore/);
});

it.each(["quality", "filename", "grant"])(
  "discards pending URL after changing %s",
  async (field) => {
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
    const pending = view.click("local_download.start");
    await flush();
    const [directory, quality, filename] = controls(view);
    if (field === "quality") change(quality, "lossless");
    if (field === "filename") change(filename, "changed.mp3");
    if (field === "grant") change(directory, 1);
    await flush();
    finish({ url: "https://example.test/old", format: "mp3" });
    await pending;
    expect(access.start).not.toHaveBeenCalled();
  },
);

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
  await first.click("local_download.start");
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
  const [directory, quality, filename] = controls(second);
  change(directory, 1);
  change(quality, "lossless");
  await flush();
  change(filename, "B.flac");
  await flush();
  await second.click("local_download.retry");
  await flush();
  await second.click("local_download.confirm_retry");
  await flush();
  expect(resolveB).not.toHaveBeenCalled();
  expect(resolveA).toHaveBeenCalledTimes(2);
  expect(resolveA).toHaveBeenLastCalledWith("320mp3", localDownloadSource(song));
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
    const pending = view.click("local_download.start");
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

it("invalidates even a reverted filename edit during URL resolution", async () => {
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
  const pending = view.click("local_download.start");
  await flush();
  const filename = controls(view)[2];
  change(filename, "changed.mp3");
  change(filename, "Song.mp3");
  finish({ url: "https://example.test/old", format: "mp3" });
  await pending;
  expect(access.start).not.toHaveBeenCalled();
});
