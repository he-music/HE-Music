import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";

// Run the real SFC setup/watchers/lifecycle. The core drawing boundary is fake;
// actual DOM drawing is covered separately by the opt-in WKWebView integration.
function mountPlayer() {
  const visibility = Vue.ref("visible");
  const clock = { time: Vue.ref(100) };
  const props = Vue.shallowReactive({
    playing: true,
    disabled: false,
    alignAnchor: "center",
    enableSpring: true,
    alignPosition: 0.5,
    lyricLines: [{ startTime: 0, endTime: 2000, words: [] }],
    clock,
  });
  const core = {
    getElement: vi.fn(() => ({})),
    getBottomLineElement: vi.fn(() => ({})),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispose: vi.fn(),
    update: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    setAlignAnchor: vi.fn(),
    setAlignPosition: vi.fn(),
    setEnableSpring: vi.fn(),
    setEnableBlur: vi.fn(),
    setEnableScale: vi.fn(),
    setLyricLines: vi.fn(),
    setCurrentTime: vi.fn(),
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const source = readFileSync(new URL("./LyricPlayer.vue", import.meta.url), "utf8").replace(
    '<script setup lang="ts">',
    `<script setup lang="ts">
import { ref, computed, watchEffect, onMounted, onUnmounted } from "vue";
import { useTemplateRef, useDocumentVisibility } from "probe-auto-imports";`,
  );
  const { descriptor } = parse(source);
  const compiled = compileScript(descriptor, { id: "LyricPlayer.vue" });
  const code = ts.transpileModule(compiled.content, {
    fileName: "LyricPlayer.ts",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: { setup: (props: object, context: object) => unknown } } = {};
  const modules: Record<string, unknown> = {
    vue: Vue,
    "probe-auto-imports": {
      useTemplateRef: () => Vue.shallowRef({ appendChild: vi.fn() }),
      useDocumentVisibility: () => visibility,
    },
    "@applemusic-like-lyrics/core": {
      LyricPlayer: class {
        constructor() {
          return core;
        }
      },
    },
    "@applemusic-like-lyrics/core/style.css": {},
  };
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected SFC import: ${name}`);
    return modules[name];
  }, exports);
  const setup = exports.default?.setup;
  if (!setup) throw new Error("Missing compiled LyricPlayer setup");
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
  });
  const app = renderer.createApp({
    setup() {
      setup(props, { expose: () => {}, emit: () => {} });
      return () => null;
    },
  });
  app.mount({});
  return {
    props,
    clock,
    visibility,
    core,
    frames,
    unmount: () => app.unmount(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("LyricPlayer SFC animation lifecycle", () => {
  it("preserves paused core animation while seek, lyric and alignment inputs still update", async () => {
    const p = mountPlayer();
    await Vue.nextTick();
    expect(p.frames.size).toBe(1);
    p.props.playing = false;
    await Vue.nextTick();
    expect(p.frames.size).toBe(1);
    expect(p.core.pause).toHaveBeenCalled();
    p.clock.time.value = 2100;
    p.props.alignPosition = 0.7;
    p.props.lyricLines = [{ startTime: 2000, endTime: 4000, words: [] }];
    await Vue.nextTick();
    expect(p.core.setCurrentTime).toHaveBeenLastCalledWith(2100);
    expect(p.core.setAlignPosition).toHaveBeenLastCalledWith(0.7);
    expect(p.core.setLyricLines).toHaveBeenLastCalledWith(p.props.lyricLines);
    expect(p.frames.size).toBe(1);
    p.unmount();
    expect(p.core.dispose).toHaveBeenCalledOnce();
    expect(p.core.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("cancels hidden queued frames and resumes exactly one loop when visible", async () => {
    const p = mountPlayer();
    await Vue.nextTick();
    const queued = [...p.frames.values()][0];
    p.visibility.value = "hidden";
    await Vue.nextTick();
    expect(p.frames.size).toBe(0);
    const calls = p.core.update.mock.calls.length;
    queued(10);
    expect(p.core.update).toHaveBeenCalledTimes(calls);
    expect(p.frames.size).toBe(0);
    p.visibility.value = "visible";
    await Vue.nextTick();
    expect(p.frames.size).toBe(1);
    p.unmount();
    expect(p.frames.size).toBe(0);
  });

  it("stops disabled animation and cancels the newest scheduled frame on unmount", async () => {
    const p = mountPlayer();
    await Vue.nextTick();
    const [id, callback] = [...p.frames.entries()][0];
    p.frames.delete(id);
    callback(10);
    expect(p.frames.size).toBe(1);
    p.props.disabled = true;
    await Vue.nextTick();
    expect(p.frames.size).toBe(0);
    p.props.disabled = false;
    await Vue.nextTick();
    expect(p.frames.size).toBe(1);
    p.unmount();
    expect(p.frames.size).toBe(0);
  });
});
