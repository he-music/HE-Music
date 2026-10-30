import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { useMygoDownloadTasks, type MygoDownloadTasksOwner } from "@/composables/mygoDownloadTasks";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";

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
function mount(
  owner: Vue.ShallowRef<MygoDownloadTasksOwner | undefined>,
  initialRoute = "download-downloading",
) {
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
it("renders the production panel, shares progress after remount, and routes every action to the same queue", async () => {
  const tasks = Vue.shallowRef<readonly LocalDownloadTask[]>([row("running")]);
  const downloads = {
    tasks,
    cancel: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    retry: vi.fn(async () => "retry"),
    retire: vi.fn(async (id: string) => {
      tasks.value = tasks.value.filter((item) => item.id !== id);
      return true;
    }),
  };
  const owner = Vue.shallowRef<MygoDownloadTasksOwner | undefined>({ downloads });
  let view = mount(owner);
  expect(view.text()).toContain("running.mp3");
  await view.click("mygo.downloads.refresh");
  await view.click("mygo.downloads.cancel");
  expect(downloads.refresh).toHaveBeenCalledWith("running");
  expect(downloads.cancel).toHaveBeenCalledWith("running");
  view.close();
  tasks.value = [
    row("failed", { done: true, phase: "failed", retryable: true }),
    row("saved", { done: true, phase: "saved", committed: true, refresh: "failed" }),
  ];
  view = mount(owner);
  await view.click("common.completed");
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.phase.saved");
  expect(view.text()).toContain("mygo.downloads.scanFailed");
  await view.click("mygo.downloads.retry");
  expect(downloads.retry).toHaveBeenCalledWith("failed");
  await view.click("mygo.downloads.clearDone");
  await Vue.nextTick();
  expect(downloads.retire).toHaveBeenCalledTimes(2);
  expect(view.text()).toContain("mygo.downloads.empty");
  owner.value = undefined;
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.unavailable");
  view.close();
});

function setupTasks(rows: readonly LocalDownloadTask[]) {
  const tasks = Vue.shallowRef(rows);
  const downloads = {
    tasks,
    cancel: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    retry: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    retire: vi.fn<(id: string) => Promise<boolean>>(async () => false),
  };
  const owner = Vue.shallowRef<MygoDownloadTasksOwner | undefined>({ downloads });
  return { tasks, downloads, owner, view: mount(owner) };
}

it("filters queue records locally, updates counts and progress, and keeps terminal recovery on the completed tab", async () => {
  const { tasks, downloads, view } = setupTasks([
    row("running"),
    row("unknown", { phase: "unknown", percent: undefined, total: 0 }),
    row("failed", { done: true, phase: "failed", interrupted: true, retryable: true }),
    row("scanning", { done: true, phase: "success", committed: true, refresh: "pending" }),
    row("saved", { done: true, phase: "saved", committed: true, refresh: "failed" }),
  ]);
  expect(view.text()).toContain("unknown.mp3");
  expect(view.text()).not.toContain("failed.mp3");
  expect(view.text()).toContain("mygo.downloads.phase.unknown");
  expect(view.text()).toContain("128 B / —");
  const counts = () => view.all().find((item) => item.props.class === "counts");
  expect(view.text(counts())).toContain("2");
  expect(view.text(counts())).toMatch(/3\s+common\.completed/);
  expect(
    view
      .all()
      .filter((item) => item.tag === "progress")
      .map((item) => item.props.value),
  ).toEqual([50, 0]);
  tasks.value = tasks.value.map((task) =>
    task.id === "running" ? { ...task, percent: 75 } : task,
  );
  await Vue.nextTick();
  expect(view.all().find((item) => item.tag === "progress")?.props.value).toBe(75);
  await view.click("common.completed");
  await Vue.nextTick();
  expect(view.text()).not.toContain("running.mp3");
  expect(view.text()).toContain("failed.mp3");
  expect(view.text()).toContain("mygo.downloads.interrupted");
  expect(view.text()).toContain("mygo.downloads.scanning");
  expect(view.text()).toContain("mygo.downloads.scanFailed");
  expect(view.text(counts())).toMatch(/2\s+download\.downloading/);
  expect(view.button("mygo.downloads.remove", view.task("scanning"))?.props.disabled).toBe(true);
  expect(view.button("mygo.downloads.retry", view.task("saved"))).toBeUndefined();
  expect(view.button("mygo.downloads.refresh")).toBeUndefined();
  expect(view.button("common.play")).toBeUndefined();
  expect(downloads.refresh).not.toHaveBeenCalled();
  expect(downloads.cancel).not.toHaveBeenCalled();
  expect(downloads.retry).not.toHaveBeenCalled();
  expect(downloads.retire).not.toHaveBeenCalled();
  await view.click("mygo.downloads.retry");
  await Vue.nextTick();
  expect(downloads.retry).toHaveBeenCalledOnce();
  expect(view.text(view.task("failed"))).toContain("mygo.downloads.actionFailed");
  await view.click("mygo.downloads.clearDone");
  await Vue.nextTick();
  expect(downloads.retire.mock.calls).toEqual([["failed"], ["saved"]]);
  expect(view.text()).toContain("scanning.mp3");
  await view.click("download.downloading");
  await Vue.nextTick();
  tasks.value = tasks.value.filter((task) => task.done);
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.empty");
  expect(view.text(counts())).toContain("0");
  view.close();
});

it("preserves pending actions and errors across tabs and ignores a replaced owner's late results", async () => {
  const { owner, downloads, view } = setupTasks([row("running")]);
  let finish: (() => void) | undefined;
  downloads.refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const action = view.click("mygo.downloads.refresh");
  await Vue.nextTick();
  expect(view.button("mygo.downloads.refresh")?.props.disabled).toBe(true);
  expect(view.button("mygo.downloads.cancel")?.props.disabled).toBe(true);
  await view.click("common.completed");
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.empty");
  await view.click("download.downloading");
  await Vue.nextTick();
  expect(view.button("mygo.downloads.refresh")?.props.disabled).toBe(true);
  finish?.();
  await action;
  await Vue.nextTick();
  downloads.cancel = vi.fn(async () => {
    throw new Error("offline");
  });
  await view.click("mygo.downloads.cancel");
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.actionFailed");
  await view.click("common.completed");
  await Vue.nextTick();
  await view.click("download.downloading");
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.actionFailed");
  const late = view.click("mygo.downloads.refresh");
  const replacement = {
    ...downloads,
    tasks: Vue.shallowRef<readonly LocalDownloadTask[]>([row("running", { received: 512 })]),
    refresh: vi.fn(async () => {}),
  };
  owner.value = { downloads: replacement };
  await Vue.nextTick();
  finish?.();
  await late;
  await Vue.nextTick();
  expect(view.text()).not.toContain("mygo.downloads.actionFailed");
  expect(view.text()).toContain("512 B");
  expect(view.button("mygo.downloads.refresh")?.props.disabled).toBe(false);
  await view.click("mygo.downloads.refresh");
  expect(replacement.refresh).toHaveBeenCalledWith("running");
  view.close();
});

it("shows persistence errors and only enables clearing when ended records are removable", async () => {
  const { downloads, owner, tasks, view } = setupTasks([
    row("scanning", { done: true, phase: "success", refresh: "pending" }),
  ]);
  const persistenceError = Vue.shallowRef("mygo.downloads.saveFailed");
  const persistentDownloads = { ...downloads, persistenceError };
  owner.value = { downloads: persistentDownloads };
  await Vue.nextTick();
  expect(view.text()).toContain("mygo.downloads.saveFailed");
  expect(view.button("mygo.downloads.clearDone")?.props.disabled).toBe(true);
  await view.click("common.completed");
  await Vue.nextTick();
  expect(view.button("mygo.downloads.remove")?.props.disabled).toBe(true);
  tasks.value = tasks.value.map((task) => ({ ...task, refresh: "failed" }));
  await Vue.nextTick();
  expect(view.button("mygo.downloads.clearDone")?.props.disabled).toBe(false);
  expect(view.button("mygo.downloads.remove")?.props.disabled).toBe(false);
  await view.click("mygo.downloads.remove");
  await Vue.nextTick();
  expect(view.text()).toContain("scanning.mp3");
  expect(view.text()).toContain("mygo.downloads.actionFailed");
  view.close();
});

it("keeps completed/downloading tabs in sync with route navigation and external route changes", async () => {
  const owner = Vue.shallowRef<MygoDownloadTasksOwner | undefined>({
    downloads: {
      tasks: Vue.shallowRef([
        row("saved", { done: true, committed: true, phase: "success" }),
        row("running"),
      ]),
      cancel: vi.fn(),
      refresh: vi.fn(),
      retry: vi.fn(),
      retire: vi.fn(),
    },
  });
  const view = mount(owner, "download-downloaded");
  expect(view.text()).toContain("saved.mp3");
  expect(view.text()).not.toContain("running.mp3");
  await view.click("download.downloading");
  await Vue.nextTick();
  expect(view.navigate).toHaveBeenCalledWith({ name: "download-downloading" });
  expect(view.text()).toContain("running.mp3");
  view.route.name = "download-downloaded";
  await Vue.nextTick();
  expect(view.text()).toContain("saved.mp3");
  expect(view.text()).not.toContain("running.mp3");
  view.close();
});
