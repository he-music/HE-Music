import { readFileSync } from "node:fs";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";

export interface SfcHostNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: SfcHostNode[];
  parent: SfcHostNode | null;
}

const node = (tag: string, text = ""): SfcHostNode => ({
  tag,
  text,
  props: {},
  children: [],
  parent: null,
});

/** Compiles the production template and runs Vue against a CPU-only host, without a DOM. */
export function mountProductionSfc(
  file: URL,
  modules: Record<string, unknown>,
  components: string[],
  scriptImports = "",
  rootProps: Record<string, unknown> = {},
) {
  const source = readFileSync(file, "utf8").replace(
    '<script setup lang="ts">',
    `<script setup lang="ts">\n${scriptImports}`,
  );
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: file.pathname, inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: Vue.Component } = {};
  const available = { vue: Vue, ...modules };
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in available)) throw new Error(`Unexpected production SFC import ${name}`);
    return available[name];
  }, exports);
  if (!exports.default) throw new Error("Missing compiled production component");
  const renderer = Vue.createRenderer<SfcHostNode, SfcHostNode>({
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
  const app = renderer.createApp(exports.default, rootProps);
  for (const name of components) {
    app.component(
      name,
      Vue.defineComponent({
        inheritAttrs: false,
        setup(_props, { attrs, slots }) {
          return () => (attrs.show === false ? null : Vue.h(name, attrs, slots.default?.()));
        },
      }),
    );
  }
  app.mount(root);
  const all = (target = root): SfcHostNode[] => [
    target,
    ...target.children.flatMap((child) => all(child)),
  ];
  let mounted = true;
  return {
    all,
    close() {
      if (!mounted) return;
      mounted = false;
      app.unmount();
    },
  };
}

export function emitHostEvent(target: SfcHostNode, event: string, ...args: unknown[]): void {
  const handler = target.props[event];
  if (typeof handler !== "function") throw new Error(`Missing host handler ${event}`);
  handler(...args);
}

export async function flushSfcHost(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
  await Vue.nextTick();
}
