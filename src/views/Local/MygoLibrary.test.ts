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
import * as VueRouter from "vue-router";
import { useSongSearch } from "@/composables/useSongSearch";
import { useLibrarySync } from "@/composables/useLibrarySync";

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
const batch = vi.fn();
const settings = Vue.reactive({
  localFilesPath: ["/synthetic/remembered"],
  showDefaultLocalPath: true,
  showLocalCover: true,
  useKeepAlive: true,
  routeAnimation: "none",
});
const cleanups: Array<() => void> = [];
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await Vue.nextTick();
};

async function mount() {
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
    vue: {
      ...Vue,
      Transition: Vue.defineComponent({
        inheritAttrs: false,
        setup:
          (_props, { slots }) =>
          () =>
            slots.default?.(),
      }),
    },
    "vue-router": VueRouter,
    "@/composables/useSongSearch": { useSongSearch },
    "@/composables/useLibrarySync": { useLibrarySync },
    "@/components/List/SongList.vue": {
      default: Vue.defineComponent({
        props: ["data", "loading", "hiddenCover", "hiddenSize"],
        setup(props) {
          return () => Vue.h("song-list", { ...props });
        },
      }),
    },
    "@/utils/helper": { renderIcon: () => () => null },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/platform/filesSession": { filesSession },
    "@/platform/localFilesSession": { localFilesSession },
    "@/components/Local/LocalScanIssues.vue": {
      default: Vue.defineComponent({ render: () => Vue.h("scan-issues") }),
    },
    "@/platform/libraryDirectoryRecovery": recoveryModule,
    "@/platform/librarySongRows": songRowsModule,
    "@/stores": { useSettingStore: () => settings },
    "@/utils/modal": { openLocalMusicDirectoryModal: manage, openBatchList: batch },
    "@/utils/player": { usePlayer: () => ({ updatePlayList: play }) },
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
  const songScript = compileScript(
    parse(readFileSync(new URL("./song.vue", import.meta.url), "utf8")).descriptor,
    { id: "song.vue", inlineTemplate: true },
  );
  const songExports: { default?: Vue.Component } = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(songScript.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )((name: string) => modules[name], songExports);
  const group = (tag: string) =>
    Vue.defineComponent({
      props: ["data", "loading"],
      setup: (props) => () => Vue.h(tag, { ...props }),
    });
  const router = VueRouter.createRouter({
    history: VueRouter.createMemoryHistory(),
    routes: [
      {
        path: "/local",
        component: exports.default,
        children: [
          { path: "songs", name: "local-songs", component: songExports.default! },
          { path: "artists", name: "local-artists", component: group("artist-view") },
          { path: "albums", name: "local-albums", component: group("album-view") },
        ],
      },
    ],
  });
  await router.push("/local/songs");
  const app = renderer.createApp({ render: () => Vue.h(VueRouter.RouterView) });
  app.use(router);
  app.component(
    "SongList",
    (modules["@/components/List/SongList.vue"] as { default: Vue.Component }).default,
  );
  for (const name of [
    "NFlex",
    "NButton",
    "NText",
    "NP",
    "NAlert",
    "NEmpty",
    "NInput",
    "NDropdown",
    "NNumberAnimation",
    "NTabs",
    "NTab",
    "SvgIcon",
  ])
    app.component(name, pass);
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (target = root): Element[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  return { all, close: () => app.unmount(), router };
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
  settings.showLocalCover = true;
  settings.showDefaultLocalPath = true;
  vi.useRealTimers();
});

it("the real local library template manages grants, scans transient rows and clears them on revoke", async () => {
  vi.useFakeTimers();
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/fixture" },
      relation: "",
      existingToken: "",
    })),
    revokeDirectory: vi.fn(async () => {}),
    defaultDirectory: vi.fn(async () => ({
      kind: "music" as const,
      displayPath: "/fixture",
      authorized: false,
    })),
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
  const view = await mount();
  expect(view.all().some((element) => element.text === "/synthetic/remembered")).toBe(false);
  const scanButton = () =>
    view.all().find((element) => element.props["data-library-action"] === "scan");
  expect(scanButton()?.props.disabled).toBe(true);
  const options = view.all().find((element) => Array.isArray(element.props.options))?.props.options;
  if (!Array.isArray(options)) throw new Error("Missing directory menu");
  options[0].props.onClick();
  expect(manage).toHaveBeenCalledOnce();
  await files.chooseDirectory();
  settings.localFilesPath = ["/fixture"];
  await flush();
  expect(scanButton()?.props.disabled).toBe(false);
  const scanClick = scanButton()?.props.onClick;
  if (typeof scanClick !== "function") throw new Error("Missing scan action");
  scanClick();
  await flush();
  const table = view.all().find((element) => element.tag === "song-list");
  expect(table?.props.data).toMatchObject([
    {
      id: "mygo-local:path:%2Ffixture/song.mp3",
      name: "中文标题",
      artists: "甲 / 乙",
      duration: 42,
    },
  ]);
  expect(JSON.stringify(table?.props.data)).not.toContain("grantToken");
  expect(table?.props.hiddenCover).toBe(false);
  expect(table?.props.hiddenSize).toBe(false);
  settings.showLocalCover = false;
  await flush();
  expect(view.all().find((element) => element.tag === "song-list")?.props.hiddenCover).toBe(true);
  settings.showLocalCover = true;
  await flush();
  expect(view.all().some((element) => element.tag === "n-data-table")).toBe(false);
  expect(view.all().some((element) => element.text === "local.scan_supported")).toBe(false);
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
  const allRows = view.all().find((element) => element.tag === "song-list")?.props.data;
  if (!Array.isArray(allRows)) throw new Error("Missing complete library rows");
  expect(allRows).toHaveLength(2);
  const filter = view.all().find((element) => "data-library-filter" in element.props);
  const updateFilter = filter?.props["onUpdate:value"];
  if (typeof updateFilter !== "function") throw new Error("Missing library filter");
  for (const search of ["other", "gamma", "OTHER ALBUM", "gama"]) {
    updateFilter(search);
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    const filtered = view.all().find((element) => element.tag === "song-list")?.props.data;
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
  const filteredOptions = view.all().find((element) => Array.isArray(element.props.options))
    ?.props.options;
  if (!Array.isArray(filteredOptions)) throw new Error("Missing filtered batch menu");
  filteredOptions[1].props.onClick();
  expect(batch).toHaveBeenCalledWith([allRows[1]], true);
  updateFilter("");
  await flush();
  expect(view.all().find((element) => element.tag === "song-list")?.props.data).toBe(allRows);
  for (const [name, tag] of [
    ["local-artists", "artist-view"],
    ["local-albums", "album-view"],
  ]) {
    await view.router.push({ name });
    await flush();
    expect(view.all().find((element) => element.tag === tag)?.props.data).toBe(allRows);
  }
  await view.router.push({ name: "local-songs" });
  await flush();
  settings.localFilesPath = [];
  settings.showDefaultLocalPath = false;
  await flush();
  expect(view.all().find((element) => element.tag === "song-list")?.props.data).toEqual([]);
  settings.showDefaultLocalPath = true;
  await flush();
  vi.mocked(readPage).mockResolvedValueOnce({
    operationId: "job",
    entries: [entry],
    issues: [{ relativePath: "", code: "item-limit" }],
    nextCursor: "1",
    done: true,
  });
  await localFilesSession.value?.scan();
  await flush();
  expect(view.all().some((element) => element.tag === "scan-issues")).toBe(true);
  expect(localFilesSession.value?.issues.value).toMatchObject([{ code: "item-limit" }]);
  expect(view.all().find((element) => element.tag === "song-list")?.props.data).toMatchObject([
    { id: "mygo-local:path:%2Ffixture/song.mp3" },
  ]);
  await files.revokeDirectory("grant");
  await flush();
  expect(view.all().find((element) => element.tag === "song-list")?.props.data).toEqual([]);
});
