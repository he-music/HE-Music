import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { useMygoDownloadTasks, type MygoDownloadTasksOwner } from "@/composables/mygoDownloadTasks";
import {
  useMygoDownloadedSongs,
  type MygoDownloadedSongsOwner,
} from "@/composables/mygoDownloadedSongs";
import type { ScanEntry } from "@/platform/mygo.bindings";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";

type Owner = MygoDownloadTasksOwner & MygoDownloadedSongsOwner;

type Node = {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: Node[];
  parent: Node | null;
};
const node = (tag: string, text = ""): Node => ({
  tag,
  text,
  props: {},
  children: [],
  parent: null,
});
function mount(owner: Vue.ShallowRef<Owner | undefined>, initialRoute = "download-downloading") {
  const { descriptor } = parse(
    readFileSync(new URL("./MygoDownloadManager.vue", import.meta.url), "utf8"),
  );
  const script = compileScript(descriptor, { id: "MygoDownloadManager.vue", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const route = Vue.reactive({ name: initialRoute });
  const navigate = vi.fn(async ({ name }: { name: string }) => {
    route.name = name;
  });
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "vue-router": { useRoute: () => route, useRouter: () => ({ push: navigate }) },
    "@/platform/filesSession": { filesSession: owner },
    "@/composables/mygoDownloadTasks": { useMygoDownloadTasks },
    "@/composables/mygoDownloadedSongs": { useMygoDownloadedSongs },
    "@/components/List/SongList.vue": {
      default: Vue.defineComponent({
        props: ["data", "loading"],
        setup: (props) => () => Vue.h("song-list", { data: props.data, loading: props.loading }),
      }),
    },
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
    return modules[name];
  }, exports);
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
      child.parent = parent;
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
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
  if (!exports.default) throw new Error("Missing SFC");
  const root = node("root");
  const app = renderer.createApp(exports.default);
  const container = (tag: string) =>
    Vue.defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => Vue.h(tag, attrs, [slots.icon?.(), slots.default?.()]);
      },
    });
  for (const name of ["NText", "NFlex", "NScrollbar"]) app.component(name, container("div"));
  app.component("NButton", container("button"));
  app.component("SImage", container("image"));
  app.component("SvgIcon", {
    props: ["name"],
    setup: () => () => Vue.h("span"),
  });
  app.component("NProgress", {
    props: ["percentage", "processing"],
    setup: (props) => () => Vue.h("progress", { value: props.percentage, max: 100 }),
  });
  app.component("NEmpty", {
    props: ["description"],
    setup: (props) => () => Vue.h("p", props.description),
  });
  const tabsKey = Symbol("tabs");
  app.component("NTabs", {
    props: ["value"],
    emits: ["update:value"],
    setup(props, { slots, emit }) {
      Vue.provide(tabsKey, {
        value: () => props.value,
        select: (value: string) => emit("update:value", value),
      });
      return () => Vue.h("div", { role: "tablist" }, slots.default?.());
    },
  });
  app.component("NTab", {
    props: ["name"],
    setup(props, { slots }) {
      const tabs = Vue.inject<{ value(): string; select(value: string): void }>(tabsKey);
      return () =>
        Vue.h(
          "button",
          {
            role: "tab",
            "aria-selected": tabs?.value() === props.name,
            onClick: () => tabs?.select(props.name),
          },
          slots.default?.(),
        );
    },
  });
  app.mount(root);
  const all = (target = root): Node[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  const text = (target = root): string =>
    target.text + target.children.map((child) => text(child)).join("");
  return {
    close: () => app.unmount(),
    unmount: () => app.unmount(),
    byTag: (tag: string) =>
      all().filter(
        (item) =>
          item.tag ===
          ({ "s-image": "image", "n-button": "button", "n-progress": "progress" }[tag] ?? tag),
      ),
    route,
    navigate,
    all,
    text,
    button(key: string, target = root) {
      return all(target).find(
        (item) =>
          item.tag === "button" && (item.props["aria-label"] === key || text(item).trim() === key),
      );
    },
    task(id: string) {
      const target = all().find(
        (item) => item.props.class === "download-item" && text(item).includes(`${id}.mp3`),
      );
      if (!target) throw new Error(`Missing task ${id}`);
      return target;
    },
    click(key: string, target = root) {
      const button = this.button(key, target);
      if (!button || typeof button.props.onClick !== "function" || button.props.disabled)
        throw new Error(`Missing or disabled button ${key}`);
      return button.props.onClick();
    },
  };
}
const row = (id: string, changes: Partial<LocalDownloadTask> = {}): LocalDownloadTask => ({
  id,
  filename: `${id}.mp3`,
  label: id,
  quality: "320mp3",
  phase: "active",
  done: false,
  committed: false,
  received: 128,
  total: 256,
  percent: 50,
  refresh: "none",
  retryable: false,
  ...changes,
});
const task = row;
function fixture() {
  const tasks = Vue.shallowRef<readonly LocalDownloadTask[]>([row("running")]);
  const queue = {
    tasks,
    cancel: vi.fn(async () => {}),
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    retry: vi.fn(async () => "retried"),
    retire: vi.fn<(id: string) => Promise<boolean>>(async () => true),
  };
  const owner = Vue.shallowRef<Owner | undefined>({
    downloads: queue,
    ready: Vue.shallowRef(true),
    directories: Vue.computed(() => [{ token: "grant", epoch: 1, displayPath: "/Music" }]),
    libraryEntries: [],
  });
  return { owner, queue };
}
it("renders song cover, artist, percentage, byte counts and active/unknown/failed order", async () => {
  const f = fixture();
  f.queue.tasks.value = [
    task("failed", { label: "Failed title", phase: "failed", done: true, retryable: true }),
    task("unknown", { label: "Unknown title", phase: "unknown" }),
    task("active", {
      label: "Active title",
      percent: 25,
      received: 1024,
      total: 4096,
      display: {
        artists: "Artist A / Artist B",
        album: "Album",
        cover: "https://cover.test/song.jpg",
        duration: 40,
      },
    }),
  ];
  const view = mount(f.owner);
  expect(view.byTag("s-image").map((image) => image.props.src)).toEqual([
    "https://cover.test/song.jpg",
    "/images/song.jpg?asset",
    "/images/song.jpg?asset",
  ]);
  expect(view.text()).toContain("Artist A / Artist B");
  expect(view.text()).toContain("25%");
  expect(view.text()).toContain("1.0 KiB / 4.0 KiB");
  expect(view.text().indexOf("Active title")).toBeLessThan(view.text().indexOf("Unknown title"));
  expect(view.text().indexOf("Unknown title")).toBeLessThan(view.text().indexOf("Failed title"));
  expect(view.byTag("n-progress")[0].props.style).toEqual({ height: "4px" });
  expect(view.byTag("n-progress")[0].props.color).toBe("rgb(var(--primary))");
  view.unmount();
});

function scannedEntry(): ScanEntry {
  return {
    ref: {
      grantToken: "grant",
      fileId: "fresh-file",
      version: "v1",
      relativePath: "album/song.flac",
    },
    relativePath: "album/song.flac",
    filename: "song.flac",
    size: 1024,
    metadata: {
      Title: "Scanned title",
      Artists: ["Scanned artist"],
      Album: "Scanned album",
      DurationSeconds: 42,
      Container: "FLAC",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 16,
      Codec: "FLAC",
    },
  };
}
it("supplies only scanned songs to the original SongList and clears synchronously when permission expires", async () => {
  const f = fixture();
  f.queue.tasks.value = [
    task("committed", {
      done: true,
      committed: true,
      phase: "success",
      target: { directory: "/Music", relativePath: "album/song.flac" },
      label: "History title",
    }),
  ];
  f.owner.value = { ...f.owner.value!, libraryEntries: [scannedEntry()] };
  const view = mount(f.owner, "download-downloaded");
  expect(view.byTag("song-list")[0].props.data).toMatchObject([
    {
      name: "Scanned title",
      artists: "Scanned artist",
      platform: "local",
      id: "mygo-local:fresh-file",
    },
  ]);
  expect(view.byTag("s-image")).toHaveLength(0);
  expect(view.text()).not.toContain("History title");
  f.owner.value!.ready.value = false;
  await Vue.nextTick();
  expect(view.byTag("song-list")[0].props.data).toEqual([]);
  expect(view.text()).toContain("local.scan_empty");
  expect(view.text()).not.toContain("History title");
  f.owner.value = { ...f.owner.value!, ready: Vue.shallowRef(true), libraryEntries: [] };
  await Vue.nextTick();
  expect(view.byTag("song-list")[0].props.data).toEqual([]);
  f.owner.value = undefined;
  await Vue.nextTick();
  expect(view.byTag("song-list")).toHaveLength(0);
  view.unmount();
});

it("does not offer retry for committed warnings even if a malformed task says retryable", () => {
  const f = fixture();
  f.queue.tasks.value = [
    task("warning", {
      done: true,
      committed: true,
      phase: "saved",
      retryable: true,
      warning: "cleanup_failed",
    }),
  ];
  const view = mount(f.owner, "download-downloaded");
  expect(view.text()).toContain("local_download.warning.cleanup_failed");
  expect(
    view.byTag("n-button").some((button) => button.props["aria-label"] === "mygo.downloads.retry"),
  ).toBe(false);
  expect(view.byTag("song-list")[0].props.data).toEqual([]);
  view.unmount();
});

it("ignores a rejected late owner callback without clearing a replacement owner's pending action", async () => {
  const f = fixture();
  let rejectOld!: (error: Error) => void;
  let resolveNew!: () => void;
  f.queue.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  const view = mount(f.owner);
  const oldAction = view.button("mygo.downloads.refresh")!.props.onClick as () => Promise<void>;
  const oldPromise = oldAction();
  await Vue.nextTick();
  const next = fixture();
  next.queue.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveNew = resolve;
      }),
  );
  f.owner.value = next.owner.value;
  await Vue.nextTick();
  const newPromise = (
    view.button("mygo.downloads.refresh")!.props.onClick as () => Promise<void>
  )();
  await Vue.nextTick();
  rejectOld(new Error("old failure"));
  await oldPromise;
  await Vue.nextTick();
  expect(view.button("mygo.downloads.refresh")!.props.disabled).toBe(true);
  expect(view.text()).not.toContain("mygo.downloads.actionFailed");
  resolveNew();
  await newPromise;
  await Vue.nextTick();
  expect(view.button("mygo.downloads.refresh")!.props.disabled).toBe(false);
  view.unmount();
});

it("keeps failed tasks in downloading with explicit retry and supports active refresh/cancel and retire", async () => {
  const f = fixture();
  const view = mount(f.owner);
  await view.click("mygo.downloads.refresh");
  await view.click("mygo.downloads.cancel");
  expect(f.queue.refresh).toHaveBeenCalledOnce();
  expect(f.queue.cancel).toHaveBeenCalledOnce();
  f.queue.tasks.value = [task("failed", { done: true, phase: "failed", retryable: true })];
  await Vue.nextTick();
  expect(view.text()).toContain("failed");
  await view.click("mygo.downloads.retry");
  await Vue.nextTick();
  expect(f.queue.retry).toHaveBeenCalledWith("failed");
  await view.click("mygo.downloads.remove");
  expect(f.queue.retire).toHaveBeenCalledWith("failed");
  view.unmount();
});
it("synchronizes route tabs and shows scanning warnings without success cards", async () => {
  const f = fixture();
  f.queue.tasks.value = [
    task("saved", {
      done: true,
      committed: true,
      phase: "saved",
      refresh: "pending",
      residualName: "song.part",
    }),
  ];
  const view = mount(f.owner);
  await view.click("common.completed");
  await Vue.nextTick();
  expect(view.navigate).toHaveBeenCalledWith({ name: "download-downloaded" });
  expect(view.text()).toContain("mygo.downloads.scanning");
  expect(view.text()).toContain("song.part");
  expect(view.button("mygo.downloads.remove")?.props.disabled).toBe(true);
  expect(view.button("mygo.downloads.clearDone")?.props.disabled).toBe(true);
  expect(view.byTag("s-image")).toHaveLength(0);
  view.route.name = "download-downloading";
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.empty");
  view.unmount();
});
it("retains removable task failures and isolates late callbacks after unmount", async () => {
  const f = fixture();
  f.queue.tasks.value = [task("failed", { done: true, phase: "failed", retryable: true })];
  f.queue.retire.mockResolvedValueOnce(false);
  const view = mount(f.owner);
  await view.click("mygo.downloads.clearDone");
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.actionFailed");
  let reject!: (error: Error) => void;
  f.queue.tasks.value = [task("running")];
  f.queue.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, failure) => {
        reject = failure;
      }),
  );
  await Vue.nextTick();
  const action = view.click("mygo.downloads.refresh");
  view.unmount();
  reject(new Error("late"));
  await action;
  const remounted = mount(f.owner);
  expect(remounted.text()).not.toContain("mygo.downloads.actionFailed");
  expect(remounted.button("mygo.downloads.refresh")?.props.disabled).toBe(false);
  remounted.unmount();
});
