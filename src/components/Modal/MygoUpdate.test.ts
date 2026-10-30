import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { UpdatesSession, updatesSession } from "@/platform/updatesSession";
import type { PlatformUpdates, UpdatesEvent, UpdatesState } from "@/platform/updates";

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
let session: UpdatesSession | undefined;
const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
  await Vue.nextTick();
};
afterEach(async () => {
  cleanups.splice(0).forEach((close) => close());
  await session?.dispose();
  session = undefined;
  vi.unstubAllGlobals();
});

function mount(owner?: UpdatesSession) {
  const { descriptor } = parse(readFileSync(new URL("./MygoUpdate.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "MygoUpdate.vue", inlineTemplate: true });
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
    "@/../package.json": { default: { version: "1.0.4" } },
    "vue-i18n": {
      useI18n: () => ({
        t: (key: string, data?: { version?: string }) =>
          data?.version ? `${key}:${data.version}` : key,
      }),
    },
    "@/platform/updatesSession": { UpdatesSession, updatesSession },
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
  const app = renderer.createApp(exports.default, { owner });
  for (const name of ["NText", "NAlert", "NFlex", "NButton", "NTag", "NScrollbar", "SvgIcon"])
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
      (element) => typeof element.props.onClick === "function" && text(element) === key,
    );
    if (!found) throw new Error(`Missing button ${key}`);
    return found;
  };
  return {
    all,
    close,
    button,
    click: (key: string) => {
      const action = button(key).props.onClick;
      if (typeof action !== "function") throw new Error("Missing action");
      return action();
    },
  };
}

it("uses native acknowledgements, confirms the exact candidate and keeps installation owned by the shell", async () => {
  const listeners = new Set<(event: UpdatesEvent) => void>();
  const emit = (id: number, state: Partial<UpdatesState> = {}) => {
    listeners.forEach((listener) =>
      listener({
        requestId: id,
        code: "",
        state: {
          epoch: 5,
          operationRevision: 0,
          stateRevision: 1,
          phase: "idle",
          code: "",
          version: "",
          notes: "",
          date: "",
          installBusy: false,
          ...state,
        },
      }),
    );
  };
  let installID = 0;
  let installRevision = 0;
  const provider: PlatformUpdates = {
    begin: vi.fn(async (id) => emit(id)),
    check: vi.fn(async (id, _epoch, revision) =>
      emit(id, {
        operationRevision: revision,
        stateRevision: 2,
        phase: "available",
        version: "2.0.0",
        notes: "<img src=x onerror=alert(1)>",
      }),
    ),
    getState: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async (id, _epoch, revision) => {
      installID = id;
      installRevision = revision;
      emit(id, {
        operationRevision: revision,
        stateRevision: 4,
        phase: "installing",
        installBusy: true,
      });
    }),
    teardown: vi.fn(async () => {}),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const warning =
    vi.fn<(options: { content: string; onPositiveClick: () => Promise<void> }) => void>();
  vi.stubGlobal("window", { $dialog: { warning } });
  session = new UpdatesSession(provider);
  await session.start();
  const ui = mount();
  await ui.click("setting.about.check_update");
  await flush();
  expect(
    ui
      .all()
      .some(
        (element) => element.text === "<img src=x onerror=alert(1)>" && !element.props.innerHTML,
      ),
  ).toBe(true);
  const version = ui.all().find((element) => element.props.class === "version");
  const versionText = (element: Element): string =>
    element.text + element.children.map(versionText).join("");
  expect(version && versionText(version)).toBe("1.0.42.0.0");
  expect(ui.all().map((element) => element.props.style)).toContainEqual({ "max-height": "500px" });
  expect(ui.all().some((element) => element.props.class === "menu")).toBe(true);
  ui.click("updates.apply");
  expect(provider.install).not.toHaveBeenCalled();
  const first = warning.mock.calls.at(-1)?.[0];
  if (!first) throw new Error("Missing confirmation");
  expect(first.content).toContain("2.0.0");
  emit(0, { operationRevision: 2, stateRevision: 3, phase: "available", version: "3.0.0" });
  await first.onPositiveClick();
  await flush();
  expect(provider.install).not.toHaveBeenCalled();
  expect(ui.all().some((element) => element.text === "updates.candidate_changed")).toBe(true);
  ui.click("updates.apply");
  const second = warning.mock.calls.at(-1)?.[0];
  if (!second) throw new Error("Missing second confirmation");
  expect(second.content).toContain("3.0.0");
  const applying = second.onPositiveClick();
  await flush();
  expect(provider.install).toHaveBeenCalledOnce();
  expect(provider.download).not.toHaveBeenCalled();
  expect(session.state.value?.phase).toBe("installing");
  ui.close();
  expect(provider.teardown).not.toHaveBeenCalled();
  emit(installID, {
    operationRevision: installRevision,
    stateRevision: 5,
    phase: "installed",
    code: "restart-required",
  });
  await applying;
  expect(session.state.value?.phase).toBe("installed");
  expect(session.ready.value).toBe(true);
  const dialog = mount(session);
  expect(dialog.all().some((element) => element.text === "updates.phase_installed")).toBe(true);
  await session.dispose();
  await flush();
  expect(dialog.button("setting.about.check_update").props.disabled).toBe(true);
  expect(dialog.all().some((element) => element.text === "updates.phase_unavailable")).toBe(true);
});
