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
function mount(owner: Vue.ShallowRef<MygoDownloadTasksOwner | undefined>) {
  const { descriptor } = parse(
    readFileSync(new URL("./MygoDownloadManager.vue", import.meta.url), "utf8"),
  );
  const script = compileScript(descriptor, { id: "MygoDownloadManager.vue", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
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
  app.mount(root);
  const all = (target = root): Node[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  const text = (target = root): string =>
    target.text + target.children.map((child) => text(child)).join("");
  return {
    close: () => app.unmount(),
    all,
    text,
    click(key: string) {
      const button = all().find((item) => item.tag === "button" && text(item) === key);
      if (!button || typeof button.props.onClick !== "function")
        throw new Error(`Missing button ${key}`);
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
