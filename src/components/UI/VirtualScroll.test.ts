import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";

type Item = { key: string; height: number };
type Row = { dataset: { index: string }; getBoundingClientRect: () => { height: number } };
interface ListState {
  itemHeights: Vue.Ref<number[]>;
  itemTops: Vue.Ref<number[]>;
  itemRefs: Vue.Ref<Row[]>;
  scrollTop: Vue.Ref<number>;
  actualStartIndex: Vue.Ref<number>;
  actualEndIndex: Vue.Ref<number>;
  wrapperRef: Vue.Ref<object | null>;
  scrollbarRef: Vue.Ref<object | null>;
  measureItemHeights: () => void;
  calculateVisibleRange: (top: number) => void;
  handleScroll: (event: { target: object }) => void;
}

const source = readFileSync(new URL("./VirtualScroll.vue", import.meta.url), "utf8").replace(
  '<script setup lang="ts">',
  `<script setup lang="ts">
import { ref, shallowRef, computed, triggerRef, watch, nextTick, onMounted, onActivated, onDeactivated, onUnmounted } from "vue";
import { useElementSize, useEventListener, useResizeObserver } from "@vueuse/core";`,
);
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "VirtualScroll.vue" });
const compiled = ts.transpileModule(script.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

async function mountList(height: number | "auto" = 500) {
  const browser = {
    scrollY: height === "auto" ? 350 : 0,
    innerHeight: 500,
    scrollTo: vi.fn(({ top }: { top: number }) => {
      browser.scrollY = top;
    }),
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", {});
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const modules: Record<string, unknown> = {
    vue: Vue,
    "naive-ui": { NScrollbar: {} },
    "@vueuse/core": {
      useElementSize: () => ({ height: Vue.ref(500) }),
      useEventListener: () => {},
      useResizeObserver: () => {},
    },
  };
  const exports: {
    default?: {
      props: Vue.ComponentObjectPropsOptions;
      setup: (props: object, context: object) => ListState;
    };
  } = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, exports);
  const component = exports.default;
  if (!component) throw new Error("Missing VirtualScroll component");
  const props = Vue.reactive({
    items: [
      ...Array.from({ length: 30 }, (_, index) => ({ key: `song-${index}`, height: 120 })),
      { key: "footer", height: 72 },
    ],
    itemHeight: 90,
    itemFixed: false,
    height,
    paddingBottom: 0,
    bufferSize: 5,
    getItemKey: (item: Item) => item.key,
  });
  let state!: ListState;
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      state = component.setup(props, {
        expose() {},
        emit() {},
      });
      return () => null;
    },
  });
  app.mount({});
  cleanups.push(() => app.unmount());
  state.wrapperRef.value = {
    isConnected: true,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 100 - browser.scrollY }),
  };
  const container = { scrollTop: 0 };
  const scrollTo = vi.fn(({ top }: { top: number }) => {
    container.scrollTop = top;
  });
  state.scrollbarRef.value = { scrollTo };
  if (height !== "auto") state.handleScroll({ target: container });
  await Vue.nextTick();
  const measure = (rows: Item[], indices = rows.map((_, index) => index)) => {
    state.itemRefs.value = rows.map((item, index) => ({
      dataset: { index: String(indices[index]) },
      getBoundingClientRect: () => ({ height: item.height }),
    }));
    state.measureItemHeights();
    state.itemRefs.value = [];
  };
  measure(props.items);
  await Vue.nextTick();
  scrollTo.mockClear();
  browser.scrollTo.mockClear();
  return {
    props,
    state,
    container,
    scrollTo,
    browser,
    measure,
    scroll(top: number) {
      container.scrollTop = top;
      state.scrollTop.value = top;
      state.calculateVisibleRange(top);
    },
  };
}

describe("VirtualScroll 行高和滚动位置", () => {
  it.each(["replace", "push"])("%s 追加时保留旧行高并将 footer 测量移至末尾", async (mode) => {
    const list = await mountList();
    list.scroll(2405);
    const start = list.state.actualStartIndex.value;
    const newItems = Array.from({ length: 30 }, (_, index) => ({
      key: `song-${index + 30}`,
      height: 150,
    }));
    if (mode === "replace") {
      list.props.items = [
        ...list.props.items.slice(0, -1).map((item) => ({ ...item })),
        ...newItems,
        { key: "footer", height: 72 },
      ];
    } else {
      list.props.items.splice(30, 0, ...newItems);
    }
    await Vue.nextTick();
    expect(list.state.itemHeights.value.slice(0, 30)).toEqual(Array(30).fill(120));
    expect(list.state.itemHeights.value.slice(30, 60)).toEqual(Array(30).fill(90));
    expect(list.state.itemHeights.value[60]).toBe(72);
    expect(list.state.itemTops.value[20]).toBe(2400);
    expect(list.state.actualStartIndex.value).toBe(start);
    expect(list.container.scrollTop).toBe(2405);
    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it("数据替换时按 key 对齐，新增歌曲不继承旧索引的高度", async () => {
    const list = await mountList();
    list.props.items = [
      { key: "footer", height: 72 },
      { key: "new-song", height: 150 },
      { key: "song-0", height: 120 },
    ];
    await Vue.nextTick();
    expect(list.state.itemHeights.value).toEqual([72, 90, 120]);
    list.props.items = [{ key: "another-song", height: 100 }];
    await Vue.nextTick();
    expect(list.state.itemHeights.value).toEqual([90]);
  });

  it("估算行高或定高模式变化时清空旧测量", async () => {
    const list = await mountList();
    list.props.itemHeight = 100;
    await Vue.nextTick();
    expect(list.state.itemHeights.value).toEqual(Array(31).fill(100));
    list.measure(list.props.items);
    list.props.itemFixed = true;
    await Vue.nextTick();
    list.props.itemFixed = false;
    await Vue.nextTick();
    expect(list.state.itemHeights.value).toEqual(Array(31).fill(100));
  });

  it("只补偿视口上方行高的变化，保持首个可见行的行内位置", async () => {
    const list = await mountList();
    list.scroll(250);
    list.measure(
      [
        { key: "song-0", height: 150 },
        { key: "song-1", height: 100 },
        { key: "song-2", height: 160 },
      ],
      [0, 1, 2],
    );
    await Vue.nextTick();
    expect(list.container.scrollTop).toBe(260);
    expect(list.container.scrollTop - list.state.itemTops.value[2]).toBe(10);
    expect(list.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 260, behavior: "auto" });
  });

  it("视口下方的行高变化不会移动滚动位置", async () => {
    const list = await mountList();
    list.scroll(250);
    list.measure([{ key: "song-4", height: 180 }], [4]);
    await Vue.nextTick();
    expect(list.container.scrollTop).toBe(250);
    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it("补偿前用户继续滚动时保留用户位置", async () => {
    const list = await mountList();
    list.scroll(250);
    list.measure([{ key: "song-0", height: 150 }], [0]);
    list.container.scrollTop = 270;
    await Vue.nextTick();
    expect(list.container.scrollTop).toBe(270);
    expect(list.state.scrollTop.value).toBe(270);
    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it("auto 高度使用外层滚动位置补偿", async () => {
    const list = await mountList("auto");
    // 初次测量已完成，将页面定位到列表内第 3 行的第 10px。
    list.browser.scrollY = 350;
    list.state.scrollTop.value = 250;
    list.measure([{ key: "song-0", height: 150 }], [0]);
    await Vue.nextTick();
    expect(list.browser.scrollY).toBe(380);
    expect(list.state.scrollTop.value).toBe(280);
    expect(list.browser.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 380, behavior: "auto" });
  });
});
