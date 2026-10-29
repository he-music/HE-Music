import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { FilesSession, filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import type { PlatformFiles } from "@/platform/files";
import type { ScanEntry } from "@/platform/mygo.bindings";
import * as recoveryModule from "@/platform/libraryDirectoryRecovery";
import * as songRowsModule from "@/platform/librarySongRows";

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
const play = vi.fn();
const manage = vi.fn();
const edit = vi.fn();
const settings = Vue.reactive({ localFilesPath: ["/synthetic/remembered"] });
const cleanups: Array<() => void> = [];
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await Vue.nextTick();
};

function mount() {
  const { descriptor } = parse(readFileSync(new URL("./MygoLibrary.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "MygoLibrary.vue", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pass = Vue.defineComponent({
    setup(_props, { attrs, slots }) {
      return () => Vue.h("stub", attrs, slots.default?.());
    },
  });
  const modules: Record<string, unknown> = {
    vue: Vue,
    "naive-ui": { NButton: pass },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/platform/filesSession": { filesSession },
    "@/platform/localFilesSession": { localFilesSession },
    "@/platform/libraryDirectoryRecovery": recoveryModule,
    "@/platform/librarySongRows": songRowsModule,
    "@/stores": { useSettingStore: () => settings },
    "@/utils/modal": { openLocalMusicDirectoryModal: manage, openSongInfoEditor: edit },
    "@/utils/player": { usePlayer: () => ({ updatePlayList: play }) },
    "@/utils/time": { secondsToTime: (seconds: number) => `${seconds}s` },
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected local library import ${name}`);
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
    setText: (target, text) => {
      target.text = text;
    },
    setElementText: (target, text) => {
      target.text = text;
      target.children = [];
    },
    patchProp: (target, key, _old, value) => {
      target.props[key] = value;
    },
    parentNode: (target) => target.parent,
    nextSibling(target) {
      const siblings = target.parent?.children ?? [];
      return siblings[siblings.indexOf(target) + 1] ?? null;
    },
  });
  const root = node("root");
  if (!exports.default) throw new Error("Missing compiled library component");
  const app = renderer.createApp(exports.default);
  for (const name of ["NH1", "NFlex", "NButton", "NText", "NP", "NAlert", "NEmpty", "NInput"])
    app.component(name, pass);
  app.component(
    "NDataTable",
    Vue.defineComponent({
      props: ["data", "columns"],
      setup(props) {
        return () => Vue.h("table", { data: props.data, columns: props.columns });
      },
    }),
  );
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (target = root): Element[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  return { all, close: () => app.unmount() };
}

const entry: ScanEntry = {
  ref: { grantToken: "grant", fileId: "file", version: "version", relativePath: "song.mp3" },
  relativePath: "song.mp3",
  filename: "song.mp3",
  size: 10,
  metadata: {
    Container: "MP3",
    Title: "中文标题",
    Artists: ["甲", "乙"],
    Album: "专辑",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    Pictures: [],
    PicturesLoaded: false,
    DurationSeconds: 42,
    BitrateKbps: 128,
    SampleRateHz: 44100,
    Channels: 2,
    BitsPerSample: 0,
    Codec: "MPEG",
  },
};
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  await filesSession.value?.dispose();
  vi.clearAllMocks();
  settings.localFilesPath = ["/synthetic/remembered"];
});

it("the real local library template manages grants, scans transient rows and clears them on revoke", async () => {
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/fixture" },
      relation: "",
      existingToken: "",
    })),
    revokeDirectory: vi.fn(async () => {}),
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: "job" })),
    readScanPage: vi.fn(async () => ({
      operationId: "job",
      entries: [entry],
      issues: [],
      nextCursor: "1",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
    readMetadata: vi.fn(),
    saveMetadata: vi.fn(),
    cancelMetadata: vi.fn(),
  };
  const files = new FilesSession(provider, { blockAudio: () => () => {} });
  await files.start();
  const view = mount();
  expect(view.all().some((element) => element.text === "/synthetic/remembered")).toBe(true);
  const clickable = () =>
    view.all().filter((element) => typeof element.props.onClick === "function");
  expect(clickable()[1]?.props.disabled).toBe(true);
  const manageClick = clickable()[0]?.props.onClick;
  if (typeof manageClick !== "function") throw new Error("Missing directory action");
  manageClick();
  expect(manage).toHaveBeenCalledOnce();
  await files.chooseDirectory();
  await flush();
  expect(clickable()[1]?.props.disabled).toBe(false);
  const scanClick = clickable()[1]?.props.onClick;
  if (typeof scanClick !== "function") throw new Error("Missing scan action");
  scanClick();
  await flush();
  const table = view.all().find((element) => element.tag === "table");
  expect(table?.props.data).toMatchObject([
    { id: "mygo-local:file", name: "中文标题", artists: "甲 / 乙", duration: 42 },
  ]);
  expect(JSON.stringify(table?.props.data)).not.toContain("grantToken");
  const columns = table?.props.columns;
  const rows = table?.props.data;
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new Error("Missing table data");
  const column: unknown = columns.find(
    (value: unknown) =>
      typeof value === "object" && value !== null && "key" in value && value.key === "edit",
  );
  if (
    typeof column !== "object" ||
    !column ||
    !("render" in column) ||
    typeof column.render !== "function"
  ) {
    throw new Error("Missing edit action");
  }
  const button: unknown = column.render(rows[0]);
  if (!Vue.isVNode(button) || typeof button.props?.onClick !== "function")
    throw new Error("Missing edit handler");
  expect(button.props.disabled).toBe(false);
  button.props.onClick();
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({ id: "mygo-local:file", path: "song.mp3" }),
  );
  const other: ScanEntry = {
    ...entry,
    ref: { ...entry.ref, fileId: "other", relativePath: "other.mp3" },
    relativePath: "other.mp3",
    filename: "other.mp3",
    metadata: { ...entry.metadata, Title: "Other", Artists: ["Gamma"], Album: "Other album" },
  };
  const readPage = provider.readScanPage;
  if (!readPage) throw new Error("Missing scan provider");
  vi.mocked(readPage).mockResolvedValueOnce({
    operationId: "job",
    entries: [entry, other],
    issues: [],
    nextCursor: "2",
    done: true,
  });
  await localFilesSession.value?.scan();
  await flush();
  const allRows = view.all().find((element) => element.tag === "table")?.props.data;
  if (!Array.isArray(allRows)) throw new Error("Missing complete library rows");
  expect(allRows).toHaveLength(2);
  const filter = view.all().find((element) => "data-library-filter" in element.props);
  const updateFilter = filter?.props["onUpdate:value"];
  if (typeof updateFilter !== "function") throw new Error("Missing library filter");
  for (const search of ["other", "gamma", "OTHER ALBUM"]) {
    updateFilter(search);
    await flush();
    const filtered = view.all().find((element) => element.tag === "table")?.props.data;
    expect(filtered).toEqual([allRows[1]]);
    if (!Array.isArray(filtered)) throw new Error("Missing filtered rows");
    expect(filtered[0]).toBe(allRows[1]);
  }
  const playFiltered = view
    .all()
    .find((element) => element.props["data-library-action"] === "play-filtered");
  if (typeof playFiltered?.props.onClick !== "function")
    throw new Error("Missing filtered playback");
  playFiltered.props.onClick();
  expect(play).toHaveBeenCalledWith([allRows[1]], allRows[1]);
  updateFilter("");
  await flush();
  expect(view.all().find((element) => element.tag === "table")?.props.data).toBe(allRows);
  await files.revokeDirectory("grant");
  await flush();
  expect(view.all().some((element) => element.tag === "table")).toBe(false);
});
