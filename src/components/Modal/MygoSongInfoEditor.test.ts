import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { LocalMetadataSession } from "@/platform/localMetadataSession";
import { LocalMetadataMatch, type MetadataMatchAPI } from "@/platform/localMetadataMatch";
import { createMetadataMatchAPI } from "@/platform/localMetadataMatchAPI";
import type { MetadataResult, ScanEntry } from "@/platform/mygo.bindings";

const matchRequests = vi.hoisted(() => vi.fn());
vi.mock("@/utils/request", () => ({
  default: matchRequests,
  API_URL: "",
  requestHemusic: vi.fn(),
}));
vi.mock("@/utils/env", () => ({ isElectron: false }));

type ElementNode = {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: ElementNode[];
  parent: ElementNode | null;
  addEventListener(): void;
  removeEventListener(): void;
  getRootNode(): object;
  tagName: string;
  value?: string;
};
const node = (tag: string, text = ""): ElementNode => ({
  tag,
  tagName: tag.toUpperCase(),
  text,
  props: {},
  children: [],
  parent: null,
  addEventListener() {},
  removeEventListener() {},
  getRootNode: () => ({ activeElement: null }),
});
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
  await Vue.nextTick();
};
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const entry: ScanEntry = {
  ref: { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "one" },
  relativePath: "song.mp3",
  filename: "song.mp3",
  size: 1,
  metadata: {
    Container: "MP3",
    Title: "old",
    Artists: ["artist"],
    Album: "album",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    Pictures: [],
    PicturesLoaded: true,
    DurationSeconds: 1,
    BitrateKbps: 1,
    SampleRateHz: 1,
    Channels: 2,
    BitsPerSample: 0,
    Codec: "MP3",
  },
};
const readResult = {
  code: "ok",
  committed: true,
  ref: entry.ref,
  sha256: "sha",
  md5: "a".repeat(32),
  info: entry.metadata,
};

function mount(session: object, api?: MetadataMatchAPI) {
  vi.stubGlobal("Document", class {});
  vi.stubGlobal("ShadowRoot", class {});
  const source = readFileSync(resolve(__dirname, "MygoSongInfoEditor.vue"), "utf8");
  const { descriptor } = parse(source, { filename: "MygoSongInfoEditor.vue" });
  const script = compileScript(descriptor, { id: "MygoSongInfoEditor.vue", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/platform/localMetadataSession": {},
    "@/stores": { useSettingStore: () => ({}) },
    "@/platform/localMetadataMatch": { LocalMetadataMatch },
    "@/platform/localMetadataMatchAPI": { createMetadataMatchAPI: () => api },
    "@/platform/mygo.bindings": {},
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", compiled)((name: string) => modules[name], exports);
  const renderer = Vue.createRenderer<ElementNode, ElementNode>({
    createElement: (tag) => node(tag),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    insert(child, parent, anchor) {
      const old = child.parent?.children.indexOf(child) ?? -1;
      if (old >= 0) child.parent?.children.splice(old, 1);
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
    nextSibling: (target) =>
      target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  });
  const root = node("root");
  if (!exports.default) throw new Error("Missing compiled production component");
  const component = exports.default;
  const currentEntry = Vue.shallowRef(entry);
  const currentSession = Vue.shallowRef(session);
  const app = renderer.createApp(
    Vue.defineComponent({
      setup: () => () =>
        Vue.h(component, { entry: currentEntry.value, session: currentSession.value }),
    }),
  );
  app.mount(root);
  const all = (target = root): ElementNode[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  const text = (target: ElementNode): string => target.text + target.children.map(text).join("");
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      app.unmount();
    }
  };
  cleanups.push(close);
  return {
    root,
    all,
    text,
    close,
    setSession: (value: object) => {
      currentSession.value = value;
    },
    setEntry: (value: ScanEntry) => {
      currentEntry.value = value;
    },
  };
}

describe("MygoSongInfoEditor renderer", () => {
  it("keeps reconcile available after read failure and routes it through the session operation", async () => {
    const reconcile = vi.fn(async () => ({
      code: "pending",
      committed: false,
      refresh: "not_required" as const,
    }));
    const session = Vue.reactive({
      operation: {
        operationId: "a".repeat(64),
        ref: entry.ref,
        completion: new Promise<never>(() => {}),
      },
      read: vi.fn(async () => {
        throw new Error("read");
      }),
      save: vi.fn(),
      reconcile,
    });
    const ui = mount(session);
    await flush();
    expect(ui.text(ui.root)).toContain("local_metadata.read_failed");
    const button = ui
      .all()
      .find((item) => item.props.onClick && ui.text(item) === "local_metadata.reconcile");
    expect(button).toBeDefined();
    await (button?.props.onClick as () => Promise<void>)();
    expect(reconcile).toHaveBeenCalledWith("a".repeat(64));
  });

  it("uses an immutable confirmed patch and ignores an older FileReader callback", async () => {
    const saveGate = new Promise<never>(() => undefined);
    const save = vi.fn(() => saveGate);
    const session = Vue.reactive({
      operation: undefined,
      read: vi.fn(async () => readResult),
      save,
      reconcile: vi.fn(),
    });
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    class Reader {
      static readers: Reader[] = [];
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        Reader.readers.push(this);
      }
      readAsDataURL() {}
    }
    vi.stubGlobal("FileReader", Reader);
    const ui = mount(session);
    await flush();
    const inputs = ui.all().filter((item) => item.tag === "input");
    const title = inputs.find((item) => typeof item.props["onUpdate:modelValue"] === "function");
    (title?.props["onUpdate:modelValue"] as (value: string) => void)("edited");
    const form = ui.all().find((item) => item.tag === "form");
    void (form?.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({
      preventDefault() {},
    });
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith(
      entry.ref,
      "sha",
      expect.objectContaining({ Title: "edited" }),
    );
    const file = inputs.find((item) => item.props.type === "file");
    const change = file?.props.onChange as (event: {
      target: { files: File[]; value: string };
    }) => void;
    change({ target: { files: [{ type: "image/png", size: 1 } as File], value: "a" } });
    change({ target: { files: [{ type: "image/png", size: 1 } as File], value: "b" } });
    Reader.readers[1].result = "data:image/png;base64,B";
    Reader.readers[1].onload?.();
    Reader.readers[0].result = "data:image/png;base64,A";
    Reader.readers[0].onload?.();
    await flush();
    expect(ui.all().find((item) => item.tag === "img")?.props.src).toBe("data:image/png;base64,B");
  });
});

function submit(ui: ReturnType<typeof mount>): Promise<void> {
  const handler = ui.all().find((item) => item.tag === "form")?.props.onSubmit;
  if (typeof handler !== "function") throw new Error("missing submit");
  return handler({ preventDefault() {} });
}
function edit(ui: ReturnType<typeof mount>, value: string): void {
  const handler = ui.all().find((item) => item.tag === "input")?.props["onUpdate:modelValue"];
  if (typeof handler !== "function") throw new Error("missing title model");
  handler(value);
}
function select(ui: ReturnType<typeof mount>, mime: string, size: number): void {
  const handler = ui.all().find((item) => item.props.type === "file")?.props.onChange;
  if (typeof handler !== "function") throw new Error("missing cover change");
  handler({ target: { files: [{ type: mime, size }], value: "fixture" } });
}

it("requires confirmation again when the form changes while confirmation is open", async () => {
  const save = vi.fn(async () => ({
    committed: true,
    code: "ok",
    ref: entry.ref,
    refresh: "complete",
  }));
  const ui = mount({ read: vi.fn(async () => readResult), save });
  await flush();
  edit(ui, "first");
  vi.stubGlobal("window", {
    confirm: vi.fn(() => {
      edit(ui, "second");
      return true;
    }),
  });
  await submit(ui);
  expect(save).not.toHaveBeenCalled();
  await flush();
  expect(ui.text(ui.root)).toContain("local_metadata.confirm_changed");
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  await submit(ui);
  expect(save).toHaveBeenCalledWith(
    entry.ref,
    "sha",
    expect.objectContaining({ Title: "second", Pictures: null }),
  );
});

it("ignores a read from a previous entry and a read after unmount", async () => {
  let finish!: (value: typeof readResult) => void;
  const late = new Promise<typeof readResult>((resolve) => (finish = resolve));
  const read = vi
    .fn()
    .mockReturnValueOnce(late)
    .mockResolvedValue({ ...readResult, info: { ...entry.metadata, Title: "new-view" } });
  const ui = mount({ read });
  await flush();
  ui.setEntry({ ...entry, ref: { ...entry.ref, fileId: "other" } });
  await flush();
  finish(readResult);
  await flush();
  expect(ui.all().find((item) => item.tag === "input")?.value).toBe("new-view");
  ui.close();
  await flush();
});

it("rejects SVG, unknown MIME and over-limit covers and protects clear/unmount against late readers", async () => {
  class Reader {
    static readers: Reader[] = [];
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    constructor() {
      Reader.readers.push(this);
    }
    readAsDataURL() {}
  }
  vi.stubGlobal("FileReader", Reader);
  const ui = mount({ read: vi.fn(async () => readResult) });
  await flush();
  for (const [mime, size] of [
    ["image/svg+xml", 10],
    ["", 10],
    ["image/png", 4 * 1024 * 1024 + 1],
  ] as const)
    select(ui, mime, size);
  expect(Reader.readers).toHaveLength(0);
  select(ui, "image/png", 4 * 1024 * 1024);
  expect(Reader.readers).toHaveLength(1);
  const clear = ui.all().find((item) => ui.text(item) === "local_metadata.clear_cover")
    ?.props.onClick;
  if (typeof clear !== "function") throw new Error("missing clear");
  clear();
  Reader.readers[0].result = "data:image/png;base64,A";
  Reader.readers[0].onload?.();
  await flush();
  expect(ui.all().find((item) => item.tag === "img")).toBeUndefined();
  select(ui, "image/png", 1);
  ui.close();
  Reader.readers[1].result = "data:image/png;base64,B";
  Reader.readers[1].onload?.();
  await flush();
  expect(ui.root.children).toHaveLength(0);
});

it("keeps the close action independent from saving and never calls cancel", async () => {
  let complete!: (value: { code: string; committed: boolean; refresh: string }) => void;
  const save = vi.fn(() => new Promise((resolve) => (complete = resolve)));
  const cancel = vi.fn();
  const ui = mount({ read: vi.fn(async () => readResult), save, cancel });
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  const pending = submit(ui);
  ui.close();
  expect(save).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  complete({ code: "ok", committed: true, refresh: "complete" });
  await pending;
});

it("shows partial refresh failure and blocks reuse of the committed baseline", async () => {
  const save = vi.fn(async () => ({
    committed: true,
    code: "ok",
    ref: entry.ref,
    refresh: "failed",
  }));
  const ui = mount({ read: vi.fn(async () => readResult), save });
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  await submit(ui);
  await flush();
  expect(ui.text(ui.root)).toContain("local_metadata.saved_refresh_failed");
  expect(ui.text(ui.root)).not.toMatch(/local_metadata\.saved(?!_)/);
  await submit(ui);
  expect(save).toHaveBeenCalledOnce();
});

it("renders saved only after the real session refresh finishes", async () => {
  let refreshDone!: () => void;
  const refresh = new Promise<void>((resolve) => (refreshDone = resolve));
  const release = vi.fn();
  const session = new LocalMetadataSession({
    access: () => ({
      current: () => true,
      read: async () => readResult,
      save: async () => ({
        code: "ok",
        committed: true,
        ref: { ...entry.ref, fileId: "a".repeat(64), version: "b".repeat(64) },
      }),
      cancel: async () => ({ code: "ok", committed: false }),
    }),
    blockAudio: () => release,
    refreshLibrary: () => refresh,
  });
  const ui = mount(session);
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  const saving = submit(ui);
  await flush();
  expect(ui.text(ui.root)).not.toMatch(/local_metadata\.saved(?!_)/);
  expect(release).not.toHaveBeenCalled();
  refreshDone();
  await saving;
  await flush();
  expect(ui.text(ui.root)).toContain("local_metadata.saved");
  expect(release).toHaveBeenCalledOnce();
});

it("renders committed errors without ref as changed originals requiring manual recovery", async () => {
  const save = vi.fn(async () => ({
    committed: true,
    code: "durability_uncertain",
    refresh: "complete",
    recoveryName: "album/backup.mp3",
    residualNames: ["album/work.mp3"],
  }));
  const ui = mount({ read: async () => readResult, save });
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  await submit(ui);
  await flush();
  expect(ui.text(ui.root)).toContain("local_metadata.committed_needs_review");
  expect(ui.text(ui.root)).toContain("album/backup.mp3");
  expect(ui.text(ui.root)).toContain("album/work.mp3");
  await submit(ui);
  expect(save).toHaveBeenCalledOnce();
});

it("submits explicit empty values for cleared tags and covers while preserving untouched fields", async () => {
  const save = vi.fn(async () => ({ code: "conflict", committed: false, refresh: "not_required" }));
  const ui = mount({ read: async () => readResult, save });
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  edit(ui, "");
  const artists = ui.all().filter((item) => item.tag === "input")[1]?.props["onUpdate:modelValue"];
  if (typeof artists !== "function") throw new Error("missing artists");
  artists("");
  const clear = ui.all().find((item) => ui.text(item) === "local_metadata.clear_cover")
    ?.props.onClick;
  if (typeof clear !== "function") throw new Error("missing clear");
  clear();
  await submit(ui);
  expect(save).toHaveBeenCalledWith(entry.ref, "sha", {
    Title: "",
    Artists: [],
    Album: null,
    AlbumArtists: null,
    Comment: null,
    Lyrics: null,
    Pictures: [],
  });
});

it.each([false, true])(
  "does not reconcile another target or clear B baseline when B read fails: %s",
  async (readFails) => {
    const reconcile = vi.fn(async () => ({
      code: "ok",
      committed: true,
      refresh: "complete",
      ref: entry.ref,
    }));
    const save = vi.fn(async () => ({
      code: "conflict",
      committed: false,
      refresh: "not_required",
    }));
    const read = vi.fn().mockResolvedValueOnce(readResult);
    if (readFails) read.mockRejectedValue(new Error("B read"));
    else read.mockResolvedValue({ ...readResult, info: { ...entry.metadata, Title: "B title" } });
    const ui = mount({
      operation: {
        operationId: "a".repeat(64),
        ref: entry.ref,
        completion: new Promise<never>(() => {}),
      },
      read,
      save,
      reconcile,
    });
    await flush();
    const b = {
      ...entry,
      relativePath: "other.mp3",
      ref: { ...entry.ref, relativePath: "other.mp3", fileId: "B" },
    };
    ui.setEntry(b);
    await flush();
    const button = ui.all().find((item) => ui.text(item) === "local_metadata.reconcile");
    expect(button?.props.disabled).toBe(true);
    const handler = button?.props.onClick;
    if (typeof handler !== "function") throw new Error("missing reconcile");
    await handler();
    await flush();
    expect(reconcile).not.toHaveBeenCalled();
    expect(ui.text(ui.root)).not.toMatch(/local_metadata\.saved(?!_)/);
    expect(ui.text(ui.root)).toContain("local_metadata.other_pending");
    expect(ui.text(ui.root)).toContain("song.mp3");
    if (!readFails) {
      vi.stubGlobal("window", { confirm: () => true });
      await submit(ui);
      expect(save).toHaveBeenCalledWith(b.ref, "sha", expect.objectContaining({ Title: null }));
    }
  },
);

it("reconciles the same grant and path after a read conflict with a different identity", async () => {
  const reconcile = vi.fn(async () => ({
    code: "ok",
    committed: true,
    refresh: "complete",
    ref: { ...entry.ref, fileId: "renamed", version: "new" },
  }));
  const ui = mount({
    operation: {
      operationId: "a".repeat(64),
      ref: entry.ref,
      completion: new Promise<never>(() => {}),
    },
    read: vi.fn(async () => ({ code: "read_ref_conflict", committed: false })),
    reconcile,
  });
  await flush();
  ui.setEntry({ ...entry, ref: { ...entry.ref, fileId: "new-view", version: "new-view" } });
  await flush();
  const button = ui.all().find((item) => ui.text(item) === "local_metadata.reconcile");
  expect(button?.props.disabled).toBe(false);
  const handler = button?.props.onClick;
  if (typeof handler !== "function") throw new Error("missing reconcile");
  await handler();
  await flush();
  expect(reconcile).toHaveBeenCalledWith("a".repeat(64));
  expect(ui.text(ui.root)).toContain("local_metadata.saved");
});

it("clears A recovery names immediately when the view changes to B even while its read hangs", async () => {
  const save = vi.fn(async () => ({
    committed: true,
    code: "durability_uncertain",
    refresh: "complete",
    recoveryName: "A-backup.mp3",
    residualNames: ["A-work.mp3"],
  }));
  const read = vi
    .fn()
    .mockResolvedValueOnce(readResult)
    .mockReturnValue(new Promise(() => undefined));
  const ui = mount({ read, save });
  vi.stubGlobal("window", { confirm: () => true });
  await flush();
  await submit(ui);
  await flush();
  expect(ui.text(ui.root)).toContain("A-backup.mp3");
  ui.setEntry({
    ...entry,
    relativePath: "B.mp3",
    ref: { ...entry.ref, relativePath: "B.mp3", fileId: "B" },
  });
  await flush();
  expect(ui.text(ui.root)).toContain("B.mp3");
  expect(ui.text(ui.root)).not.toContain("A-backup.mp3");
  expect(ui.text(ui.root)).not.toContain("A-work.mp3");
});

it("does not revive the old baseline when a pending read returns after save completion", async () => {
  let read!: (value: MetadataResult) => void;
  let saved!: (value: MetadataResult) => void;
  const reading = new Promise<MetadataResult>((resolve) => {
    read = resolve;
  });
  const saving = new Promise<MetadataResult>((resolve) => {
    saved = resolve;
  });
  const session = new LocalMetadataSession({
    access: () => ({
      current: () => true,
      read: () => reading,
      save: () => saving,
      cancel: async () => ({ code: "ok", committed: false }),
    }),
    blockAudio: () => () => {},
    refreshLibrary: async () => {},
  });
  cleanups.push(() => session.dispose());
  const running = session.save(entry.ref, "sha", {
    Title: "new",
    Artists: null,
    Album: null,
    AlbumArtists: null,
    Comment: null,
    Lyrics: null,
    Pictures: null,
  });
  const ui = mount(session);
  await flush();
  saved({
    code: "ok",
    committed: true,
    ref: { ...entry.ref, fileId: "c".repeat(64), version: "d".repeat(64) },
  });
  await running;
  await flush();
  expect(ui.text(ui.root)).toContain("local_metadata.saved");
  read(readResult);
  await flush();
  expect(
    ui.all().find((item) => item.tag === "button" && item.props.type === "submit")?.props.disabled,
  ).toBe(true);
});

it.each([false, true])(
  "observes late native completion after the first save wait, moved view: %s",
  async (moveView) => {
    vi.useFakeTimers();
    let finish!: (value: MetadataResult) => void;
    const native = new Promise<MetadataResult>((resolve) => {
      finish = resolve;
    });
    const release = vi.fn();
    const session = new LocalMetadataSession({
      access: (ref) => ({
        current: () => true,
        read: async () => ({
          ...readResult,
          ref,
          info: { ...entry.metadata, Title: ref.relativePath },
        }),
        save: () => native,
        cancel: async () => ({ code: "ok", committed: false }),
      }),
      blockAudio: () => release,
      refreshLibrary: async () => {},
    });
    cleanups.push(() => session.dispose());
    const ui = mount(session);
    vi.stubGlobal("window", { confirm: () => true });
    await flush();
    const firstWait = submit(ui);
    await vi.advanceTimersByTimeAsync(35_000);
    await firstWait;
    expect(ui.text(ui.root)).toContain("local_metadata.pending");
    if (moveView) {
      ui.setEntry({
        ...entry,
        relativePath: "B.mp3",
        ref: { ...entry.ref, relativePath: "B.mp3", fileId: "B" },
      });
      await flush();
    }
    finish({
      code: "ok",
      committed: true,
      ref: { ...entry.ref, fileId: "c".repeat(64), version: "d".repeat(64) },
    });
    await flush();
    expect(release).toHaveBeenCalledOnce();
    expect(ui.text(ui.root).includes("local_metadata.saved")).toBe(!moveView);
    expect(ui.text(ui.root)).not.toContain("local_metadata.pending");
  },
);

const matchOption = {
  id: 42,
  title: "matched title",
  artists: ["matched artist"],
  album: "matched album",
  comment: "alias",
  cover: "",
};
const matchDraft = {
  ...matchOption,
  lyrics: "matched lyric",
  picture: { MIME: "image/png", Type: 3, Description: "", Data: "aW1hZ2U=" },
};
function matchSession() {
  return Vue.reactive({
    operation: undefined,
    ownsReference: vi.fn(() => true),
    read: vi.fn(async () => readResult),
    save: vi.fn(async () => ({ code: "ok", committed: false, refresh: "not_required" })),
    reconcile: vi.fn(),
  });
}
function deferredMatch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function click(ui: ReturnType<typeof mount>, label: string) {
  const button = ui.all().find((item) => item.tag === "button" && ui.text(item).includes(label));
  if (!button) throw new Error(`Missing button ${label}`);
  return (button.props.onClick as () => Promise<void> | void)();
}
function titleValue(ui: ReturnType<typeof mount>) {
  return ui.all().find((item) => item.tag === "input" && item.props["onUpdate:modelValue"])?.value;
}

describe("MygoSongInfoEditor online selection", () => {
  it("keeps selection editable and saves only through the original SHA transaction", async () => {
    const session = matchSession();
    const api = {
      search: vi.fn(async () => [matchOption]),
      details: vi.fn(async () => matchDraft),
    };
    const ui = mount(session, api);
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    await flush();
    await click(ui, "modal.auto_match_tag");
    await flush();
    expect(titleValue(ui)).toBe("old");
    expect(session.save).not.toHaveBeenCalled();
    await click(ui, "matched title");
    await flush();
    expect(titleValue(ui)).toBe("matched title");
    expect(session.save).not.toHaveBeenCalled();
    const input = ui
      .all()
      .find((item) => item.tag === "input" && item.props["onUpdate:modelValue"]);
    (input?.props["onUpdate:modelValue"] as (value: string) => void)("user corrected");
    const form = ui.all().find((item) => item.tag === "form");
    await (form?.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({
      preventDefault() {},
    });
    expect(session.save).toHaveBeenCalledWith(
      entry.ref,
      "sha",
      expect.objectContaining({
        Title: "user corrected",
        Lyrics: "matched lyric",
        Pictures: [matchDraft.picture],
      }),
    );
  });

  it("cancels pending search without applying or saving and prevents duplicate clicks", async () => {
    const gate = deferredMatch<(typeof matchOption)[]>();
    const session = matchSession();
    const api = { search: vi.fn(() => gate.promise), details: vi.fn(async () => matchDraft) };
    const ui = mount(session, api);
    await flush();
    const pending = click(ui, "modal.auto_match_tag");
    await click(ui, "modal.auto_match_tag");
    await click(ui, "local_metadata.match_cancel");
    gate.resolve([matchOption]);
    await pending;
    await flush();
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.details).not.toHaveBeenCalled();
    expect(titleValue(ui)).toBe("old");
    expect(session.save).not.toHaveBeenCalled();
    expect(ui.text(ui.root)).not.toContain("matched title");
  });

  it.each(["owner", "entry", "ref", "grant", "close"])(
    "rejects detail response after %s changes",
    async (kind) => {
      const gate = deferredMatch<typeof matchDraft>();
      const session = matchSession();
      const api = { search: vi.fn(async () => [matchOption]), details: vi.fn(() => gate.promise) };
      const ui = mount(session, api);
      await flush();
      await click(ui, "modal.auto_match_tag");
      await flush();
      const pending = click(ui, "matched title");
      if (kind === "owner") ui.setSession(matchSession());
      if (kind === "entry") ui.setEntry({ ...entry });
      if (kind === "ref") ui.setEntry({ ...entry, ref: { ...entry.ref, version: "two" } });
      if (kind === "grant") session.ownsReference.mockReturnValue(false);
      if (kind === "close") await click(ui, "common.cancel");
      await flush();
      gate.resolve(matchDraft);
      await pending;
      await flush();
      expect(titleValue(ui)).toBe("old");
      expect(session.save).not.toHaveBeenCalled();
    },
  );

  it("keeps existing form and cover when detail request fails", async () => {
    const session = matchSession();
    const api = {
      search: vi.fn(async () => [matchOption]),
      details: vi.fn(async () => {
        throw new Error("cover failed");
      }),
    };
    const ui = mount(session, api);
    await flush();
    await click(ui, "modal.auto_match_tag");
    await flush();
    await click(ui, "matched title");
    await flush();
    expect(titleValue(ui)).toBe("old");
    expect(ui.text(ui.root)).toContain("message.match_fail");
    expect(session.save).not.toHaveBeenCalled();
  });
});

it.each([
  { input: { name: "solo artist" }, expected: ["solo artist"] },
  { input: "solo artist", expected: ["solo artist"] },
  {
    input: [{ name: "first artist" }, "second artist"],
    expected: ["first artist", "second artist"],
  },
])(
  "preserves normalized artist $input through API selection and save patch",
  async ({ input, expected }) => {
    matchRequests.mockReset();
    matchRequests.mockImplementation(async (request: { url: string }) => {
      if (request.url === "/search/match")
        return {
          result: {
            songs: [{ id: 42, name: "selected song", artist: input, album: "matched album" }],
          },
        };
      if (request.url === "/lyric/new") return { lrc: { lyric: "selected lyric" } };
      throw new Error(`Unexpected route ${request.url}`);
    });
    const session = matchSession();
    const ui = mount(
      session,
      createMetadataMatchAPI(() => ({
        downloadLyric: false,
        downloadLyricTran: false,
        downloadLyricRoma: false,
      })),
    );
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    await flush();
    await click(ui, "modal.auto_match_tag");
    await flush();
    expect(session.save).not.toHaveBeenCalled();
    await click(ui, "selected song");
    await flush();
    expect(session.save).not.toHaveBeenCalled();
    const artistInput = ui.all().filter((item) => item.tag === "input")[1];
    expect(artistInput.value).toBe(expected.join(", "));
    const form = ui.all().find((item) => item.tag === "form");
    await (form?.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({
      preventDefault() {},
    });
    expect(session.save).toHaveBeenCalledExactlyOnceWith(
      entry.ref,
      "sha",
      expect.objectContaining({
        Title: "selected song",
        Artists: expected,
        Lyrics: "selected lyric",
      }),
    );
  },
);
