import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import type { PlatformFiles } from "@/platform/files";
import type { DirectorySelection } from "@/platform/mygo.bindings";
import { FilesSession, filesSession } from "@/platform/filesSession";
import * as directoryModule from "@/platform/localDirectorySession";
import * as recoveryModule from "@/platform/libraryDirectoryRecovery";

const host = vi.hoisted(() => ({ electron: false, mygo: true }));
const setting = vi.hoisted(() => ({
  localFilesPath: ["/synthetic/imported"],
  downloadPath: "/synthetic/imported-download",
}));
const legacy = vi.hoisted(() => ({ change: vi.fn(), open: vi.fn() }));
vi.mock("@/stores", () => ({ useSettingStore: () => setting }));
vi.mock("@/utils/env", () => ({
  get isElectron() {
    return host.electron;
  },
  get isMygo() {
    return host.mygo;
  },
}));
vi.mock("@/utils/modal", () => ({ openLocalMusicDirectoryModal: legacy.open }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { useLocalSettings } from "@/components/Setting/config/local";

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
const unmounts: Array<() => void> = [];
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await Vue.nextTick();
};
function mountDirectory() {
  const { descriptor } = parse(
    readFileSync(new URL("./LocalMusicDirectory.vue", import.meta.url), "utf8"),
  );
  const compiled = compileScript(descriptor, {
    id: "LocalMusicDirectory.vue",
    inlineTemplate: true,
  });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/stores": { useSettingStore: () => setting },
    "@/components/Global/SvgIcon.vue": { default: Vue.defineComponent(() => () => null) },
    "@/utils/helper": { changeLocalPath: legacy.change },
    "@/utils/env": { isElectron: host.electron, isMygo: host.mygo },
    "@/platform/localDirectorySession": directoryModule,
    "@/platform/libraryDirectoryRecovery": recoveryModule,
    "@/platform/filesSession": { filesSession },
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected directory import ${name}`);
    return modules[name];
  }, exports);
  const renderer = Vue.createRenderer<Element, Element>({
    createElement: (tag) => node(tag),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    insert(child, parent, anchor) {
      if (child.parent) {
        const index = child.parent.children.indexOf(child);
        if (index >= 0) child.parent.children.splice(index, 1);
      }
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
      child.parent = parent;
    },
    remove(child) {
      const index = child.parent?.children.indexOf(child) ?? -1;
      if (index >= 0) child.parent!.children.splice(index, 1);
      child.parent = null;
    },
    setText: (target, text) => (target.text = text),
    setElementText(target, text) {
      target.text = text;
      target.children = [];
    },
    patchProp: (target, key, _old, value) => (target.props[key] = value),
    parentNode: (target) => target.parent,
    nextSibling(target) {
      const siblings = target.parent?.children ?? [];
      return siblings[siblings.indexOf(target) + 1] ?? null;
    },
  });
  const root = node("root");
  const app = renderer.createApp(exports.default!);
  const pass = Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () =>
        Vue.h(
          "stub",
          attrs,
          Object.values(slots).flatMap((slot) => slot?.() ?? []),
        );
    },
  });
  for (const name of [
    "NText",
    "NScrollbar",
    "NList",
    "NListItem",
    "NEmpty",
    "NThing",
    "NFlex",
    "NButton",
  ])
    app.component(name, pass);
  app.mount(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    app.unmount();
  };
  unmounts.push(close);
  function all(target = root): Element[] {
    return [target, ...target.children.flatMap((child) => all(child))];
  }
  return {
    text: () =>
      all()
        .map((element) => element.text)
        .join(" "),
    buttons: () => all().filter((element) => typeof element.props.onClick === "function"),
    async click(action: string) {
      const target = all().find((element) => element.props["data-directory-action"] === action);
      expect(target, action).toBeDefined();
      expect(target!.props.disabled).not.toBe(true);
      await (target!.props.onClick as () => unknown)();
      await flush();
    },
    close,
  };
}
function provider(): PlatformFiles {
  return {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn(async (): Promise<DirectorySelection> => ({
      status: "selected",
      grant: { token: "synthetic-token", displayPath: "/synthetic/selected", epoch: 1 },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(async () => ({
      kind: "music" as const,
      displayPath: "/synthetic/default",
      authorized: false,
    })),
    revokeDirectory: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    importSettings: vi.fn(async () => ({ status: "cancelled" as const, document: null })),
    exportSettings: vi.fn(async () => ({ status: "saved" as const })),
    startScan: vi.fn(async () => ({ operationId: "scan-job" })),
    readScanPage: vi.fn(async () => ({
      operationId: "scan-job",
      entries: [],
      issues: [],
      nextCursor: "1",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
  };
}
afterEach(async () => {
  unmounts.splice(0).forEach((unmount) => unmount());
  await filesSession.value?.dispose();
  host.electron = false;
  host.mygo = true;
  setting.localFilesPath = ["/synthetic/imported"];
  vi.clearAllMocks();
});

describe("LocalMusicDirectory真实SFC", () => {
  it("设置入口只开放目录授权，Web隐藏且Electron保留旧组", () => {
    const config = useLocalSettings();
    expect(config.groups.flatMap((group) => group.items.map((item) => item.key))).toEqual([
      "localFilesPath",
    ]);
    const item = config.groups[0].items[0];
    if (item.type !== "button") throw new Error("Expected directory button");
    item.action?.();
    expect(legacy.open).toHaveBeenCalledOnce();
    host.mygo = false;
    expect(useLocalSettings().groups).toEqual([]);
    host.electron = true;
    const keys = useLocalSettings().groups.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).toContain("downloadPath");
    expect(keys).toContain("downloadMeta");
    expect(keys).toContain("showDefaultLocalPath");
  });

  it("重新授权后保存提示并只自动扫描一次，取消与重开不重复扫描", async () => {
    const native = provider();
    const session = new FilesSession(native);
    await session.start();
    const ui = mountDirectory();
    expect(ui.text()).toContain("/synthetic/imported");
    expect(session.directories.value).toEqual([]);
    await ui.click("default");
    expect(ui.text()).toContain("/synthetic/default");
    expect(session.directories.value).toEqual([]);
    await ui.click("choose");
    expect(ui.text()).toContain("/synthetic/selected");
    expect(native.startScan).toHaveBeenCalledExactlyOnceWith(1, "synthetic-token");
    expect(setting.localFilesPath).toEqual(["/synthetic/imported", "/synthetic/selected"]);
    vi.mocked(native.chooseDirectory).mockResolvedValueOnce({
      status: "cancelled",
      grant: null,
      relation: "",
      existingToken: "",
    });
    await ui.click("choose");
    expect(ui.text()).toContain("setting.local.directory_cancelled");
    expect(session.directories.value).toHaveLength(1);
    expect(native.startScan).toHaveBeenCalledOnce();
    ui.close();
    const reopened = mountDirectory();
    expect(reopened.text()).toContain("/synthetic/selected");
    expect(native.begin).toHaveBeenCalledOnce();
    expect(native.teardown).not.toHaveBeenCalled();
    vi.mocked(native.revokeDirectory).mockRejectedValueOnce(new Error("synthetic failure"));
    await reopened.click("revoke");
    expect(reopened.text()).toContain("setting.local.directory_failed");
    expect(session.directories.value).toHaveLength(1);
    await reopened.click("revoke");
    expect(session.directories.value).toEqual([]);
    expect(legacy.change).not.toHaveBeenCalled();
    expect(setting.localFilesPath).toEqual(["/synthetic/imported"]);
  });

  it("无会话禁用按钮、Web安全；Electron目录操作仍调用旧helper", async () => {
    const ui = mountDirectory();
    expect(ui.text()).toContain("setting.local.directory_unavailable");
    expect(ui.buttons().every((button) => button.props.disabled === true)).toBe(true);
    ui.close();
    host.mygo = false;
    const web = mountDirectory();
    expect(web.buttons()).toHaveLength(0);
    web.close();
    host.electron = true;
    const electron = mountDirectory();
    const add = electron.buttons().find((button) => !button.props.quaternary)!;
    await (add.props.onClick as () => unknown)();
    expect(legacy.change).toHaveBeenCalledOnce();
  });
});
