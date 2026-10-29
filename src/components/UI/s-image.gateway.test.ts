import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { gatewayProxyUrl } from "@/platform/gateway";
import { emitHostEvent, flushSfcHost, type SfcHostNode } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

function mount(src: string | undefined, defaultSrc: string, visible = true) {
  const visibility = Vue.ref(visible);
  const props = Vue.reactive({ src, defaultSrc, observeVisibility: true, releaseOnHide: true });
  const source = readFileSync(new URL("./s-image.vue", import.meta.url), "utf8").replace(
    '<script setup lang="ts">',
    '<script setup lang="ts">\nimport { ref, computed, watch, onUnmounted } from "vue";\nimport { useElementVisibility } from "@vueuse/core";',
  );
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "gateway-image", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const transition = Vue.defineComponent({
    setup(_props, { slots }) {
      return () => slots.default?.();
    },
  });
  const modules: Record<string, unknown> = {
    vue: { ...Vue, Transition: transition },
    "@vueuse/core": { useElementVisibility: () => visibility },
    "@/platform/gateway": { gatewayProxyUrl },
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected image import ${name}`);
    return modules[name];
  }, exports);
  if (!exports.default) throw new Error("Missing production image component");
  const component = exports.default;
  const node = (tag: string, text = ""): SfcHostNode => ({
    tag,
    text,
    props: {},
    children: [],
    parent: null,
  });
  const renderer = Vue.createRenderer<SfcHostNode, SfcHostNode>({
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
    nextSibling: (target) => {
      const siblings = target.parent?.children ?? [];
      return siblings[siblings.indexOf(target) + 1] ?? null;
    },
  });
  const root = node("root");
  const app = renderer.createApp(
    Vue.defineComponent({ setup: () => () => Vue.h(component, props) }),
  );
  app.mount(root);
  const all = (target = root): SfcHostNode[] => [target, ...target.children.flatMap(all)];
  const images = () => all().filter((entry) => entry.tag === "img");
  let mounted = true;
  const close = () => {
    if (mounted) app.unmount();
    mounted = false;
  };
  cleanups.push(close);
  return { props, visibility, images, close, root };
}

it.each([false, true])("s-image 在 mygo=%s 时派生封面与默认图而不改 props", async (mygo) => {
  vi.stubGlobal("window", mygo ? { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123" } : {});
  const src = "https://images.fixture.invalid/song.jpg";
  const fallback = "https://images.fixture.invalid/default.jpg";
  const image = mount(src, fallback);
  await flushSfcHost();
  expect(image.images().map((entry) => entry.props.src)).toEqual([
    gatewayProxyUrl(fallback),
    gatewayProxyUrl(src),
  ]);
  expect(image.props.src).toBe(src);
  expect(image.props.defaultSrc).toBe(fallback);
  const cover = image.images().find((entry) => entry.props.alt === "image");
  if (!cover) throw new Error("Missing cover");
  emitHostEvent(cover, "onError", new Event("error"));
  await flushSfcHost();
  expect(image.images().map((entry) => entry.props.src)).toEqual([
    gatewayProxyUrl(fallback),
    gatewayProxyUrl(fallback),
  ]);
});

it("s-image 迟到的图片通过可视性加载、隐藏释放且卸载不改源", async () => {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:45123" });
  const image = mount(undefined, "/images/song.jpg?asset", false);
  const src = "https://images.fixture.invalid/late.jpg";
  image.props.src = src;
  await flushSfcHost();
  expect(image.images()).toHaveLength(1);
  image.visibility.value = true;
  await flushSfcHost();
  expect(image.images().some((entry) => entry.props.src === gatewayProxyUrl(src))).toBe(true);
  image.visibility.value = false;
  await flushSfcHost();
  expect(image.images()).toHaveLength(1);
  image.close();
  await flushSfcHost();
  expect(image.root.children).toHaveLength(0);
  expect(image.props.src).toBe(src);
});
