import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { ShortcutSession, normalizeShortcut } from "./shortcutSession";
import {
  playbackShortcutActions,
  type PlatformShortcuts,
  type GlobalShortcutStatus,
} from "./shortcuts";
import type { ShortcutEvent } from "./mygo.bindings";

vi.stubGlobal("localStorage", {});
const { useShortcutStore } = await import("@/stores/shortcut");
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
};
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), { $message: { warning: vi.fn(), success: vi.fn() } }),
  );
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const store = useShortcutStore();
  let generation = 0;
  const callbacks = new Set<(event: ShortcutEvent) => void>();
  const provider: PlatformShortcuts = {
    actions: playbackShortcutActions,
    replace: vi.fn(async (_generation, enabled, bindings) => ({
      generation: ++generation,
      enabled,
      suspended: false,
      results: bindings.map((binding) => ({
        ...binding,
        normalized: normalizeShortcut(binding.accelerator, "darwin"),
        status: enabled ? "registered" : "disabled",
        error: "",
      })),
    })),
    suspend: vi.fn(async () => ({
      generation: ++generation,
      enabled: false,
      suspended: true,
      results: [],
    })),
    teardown: vi.fn(async () => {}),
    check: vi.fn(),
    onAction: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
  };
  const execute = vi.fn();
  const failure = vi.fn();
  const session = new ShortcutSession(store, provider, execute, failure, "darwin");
  cleanups.push(() => session.dispose());
  return {
    store,
    provider,
    session,
    execute,
    failure,
    callbacks,
    emit: (generation: number) =>
      callbacks.forEach((callback) => callback({ generation, action: "playOrPause" })),
  };
}

function mountRecorder(
  store: ReturnType<typeof useShortcutStore>,
  provider: PlatformShortcuts,
  kind = "mygo",
) {
  const { descriptor } = parse(
    readFileSync(
      new URL("../components/Setting/components/ShortcutRecorder.vue", import.meta.url),
      "utf8",
    ),
  );
  const compiled = compileScript(descriptor, { id: "ShortcutRecorder.vue" });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: Vue,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/stores": { useShortcutStore: () => store },
    "@/platform": { platform: { os: "darwin", kind, shortcuts: provider } },
    "@/platform/shortcutSession": { normalizeShortcut, shortcutSession: () => sessionFor(store) },
    "@/utils/helper": { formatForGlobalShortcut: (value: string) => value.replace("Digit", "num") },
  };
  const exports: {
    default?: { setup: (props: object, context: object) => Record<string, unknown> };
  } = {};
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(name);
    return modules[name];
  }, exports);
  let state: Record<string, unknown> = {};
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
      state = exports.default!.setup(
        { shortcutKey: "playOrPause", allowGlobal: true },
        { expose() {} },
      );
      return () => null;
    },
  });
  app.mount({});
  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    app.unmount();
  };
  cleanups.unshift(unmount);
  let focused = false;
  const blurInput = vi.fn(() => {
    focused = false;
    (state.onBlur as () => void)();
  });
  for (const name of ["localInput", "globalInput"]) {
    const input = state[name] as Vue.Ref<{ blur: () => void } | undefined> | undefined;
    if (input) input.value = { blur: blurInput };
  }
  return {
    focus: (global = true) => {
      if (focused) return;
      focused = true;
      (state.onFocus as (value: boolean) => void)(global);
    },
    blur: blurInput,
    blurInput,
    state,
    unmount,
    key: (
      code: string,
      options: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
    ) => {
      (state.keyHandled as Vue.Ref<string>).value = "";
      (state.onKeyDown as (event: object) => void)({
        code,
        repeat: false,
        preventDefault() {},
        stopPropagation() {},
        ...options,
      });
    },
  };
}
import { shortcutSession as sessionFor } from "./shortcutSession";

describe("shortcut platform normalization", () => {
  it("区分Mac/Windows的Ctrl和Super，同时按下也保持不同", () => {
    for (const os of ["darwin", "win32"] as const) {
      expect(normalizeShortcut("Ctrl+KeyA", os)).not.toBe(normalizeShortcut("Super+A", os));
      expect(normalizeShortcut("Ctrl+Super+A", os)).not.toBe(normalizeShortcut("Super+A", os));
      expect(normalizeShortcut("Ctrl+Super+A", os)).not.toBe(normalizeShortcut("Ctrl+A", os));
    }
    expect(normalizeShortcut("CmdOrCtrl+ArrowLeft", "darwin")).toBe(
      normalizeShortcut("Super+Left", "darwin"),
    );
    expect(normalizeShortcut("CmdOrCtrl+Digit1", "win32")).toBe(
      normalizeShortcut("Ctrl+1", "win32"),
    );
    expect(normalizeShortcut("Control+Ctrl+KeyA", "darwin")).toBe(
      normalizeShortcut("Ctrl+A", "darwin"),
    );
  });
});

describe("shortcut Pinia and actual recorder setup", () => {
  it("默认开启，仅读全局配置；页内录制不重新注册；原生事件只接受当前generation", async () => {
    const f = fixture();
    await f.session.start();
    expect(f.provider.replace).toHaveBeenCalledWith(0, true, expect.any(Array));
    f.emit(1);
    expect(f.execute).toHaveBeenCalledOnce();
    f.store.shortcutList.playOrPause.shortcut = "KeyX";
    f.store.shortcutList.toggleDesktopLyric.globalShortcut = "Super+KeyX";
    await flush();
    expect(f.provider.replace).toHaveBeenCalledOnce();
    const recorder = mountRecorder(f.store, f.provider);
    recorder.focus(false);
    recorder.key("KeyQ");
    recorder.blur();
    await flush();
    expect(f.provider.replace).toHaveBeenCalledOnce();
    f.store.shortcutList.playOrPause.globalShortcut = "Super+Shift+KeyX";
    f.emit(1);
    expect(f.execute).toHaveBeenCalledOnce();
    await flush();
    f.emit(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.session.owns("Super+Shift+KeyX")).toBe(true);
    expect(f.session.owns("Ctrl+Shift+KeyX")).toBe(false);
  });

  it("全局录制暂停，数字/Ctrl/Meta保真，blur和卸载恢复最新配置", async () => {
    const f = fixture();
    await f.session.start();
    const recorder = mountRecorder(f.store, f.provider);
    recorder.focus();
    await flush();
    expect(f.provider.suspend).toHaveBeenCalledOnce();
    recorder.key("Digit1", { ctrlKey: true });
    expect(f.store.shortcutList.playOrPause.globalShortcut).toBe("Control+Digit1");
    recorder.key("KeyX", { metaKey: true, ctrlKey: true });
    expect(f.store.shortcutList.playOrPause.globalShortcut).toBe("Super+Control+KeyX");
    recorder.key("KeyD", { metaKey: true, shiftKey: true });
    expect(f.store.shortcutList.playOrPause.globalShortcut).toBe("Super+Shift+KeyD");
    recorder.blur();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.arrayContaining([{ action: "playOrPause", accelerator: "Super+Shift+KeyD" }]),
    );
    recorder.focus();
    await flush();
    recorder.unmount();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.any(Array),
    );
  });

  it("并发录制直到最后token释放才恢复；关闭/重置不被旧blur重新打开", async () => {
    const f = fixture();
    await f.session.start();
    const first = mountRecorder(f.store, f.provider),
      second = mountRecorder(f.store, f.provider);
    first.focus();
    second.focus();
    await flush();
    first.blur();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Array),
    );
    f.store.globalOpen = false;
    second.unmount();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Array),
    );
    f.store.$reset();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.any(Array),
    );
  });

  it("窗口blur无需元素blur即恢复最新配置，回窗可再次录制且重复结束幂等", async () => {
    const f = fixture();
    await f.session.start();
    const recorder = mountRecorder(f.store, f.provider);
    recorder.focus();
    recorder.key("KeyD", { metaKey: true, shiftKey: true });
    await flush();
    expect(f.provider.suspend).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.arrayContaining([{ action: "playOrPause", accelerator: "Super+Shift+KeyD" }]),
    );
    expect((recorder.state.isFocus as Vue.Ref<boolean>).value).toBe(false);
    expect((recorder.state.isGlobalFocus as Vue.Ref<boolean>).value).toBe(false);
    expect((recorder.state.keyHandled as Vue.Ref<string>).value).toBe("");
    expect(recorder.blurInput).toHaveBeenCalledOnce();
    const restoredCalls = vi.mocked(f.provider.replace).mock.calls.length;
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(f.provider.replace).toHaveBeenCalledTimes(restoredCalls);
    recorder.focus();
    await flush();
    expect(f.provider.suspend).toHaveBeenCalledTimes(2);
    recorder.key("KeyQ", { ctrlKey: true });
    expect(f.store.shortcutList.playOrPause.globalShortcut).toBe("Control+KeyQ");
  });

  it("仅页面隐藏结束录制，多token仍暂停，关闭开关后失焦不重启", async () => {
    const f = fixture();
    await f.session.start();
    const externalToken = f.session.beginRecording();
    const recorder = mountRecorder(f.store, f.provider);
    recorder.focus();
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(recorder.blurInput).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(recorder.blurInput).toHaveBeenCalledOnce();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Array),
    );
    await f.session.endRecording(externalToken);
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.any(Array),
    );
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    recorder.focus();
    await flush();
    f.store.globalOpen = false;
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Array),
    );
  });

  it("卸载移除失焦和隐藏监听；旧Recorder事件不释放新shell的录制", async () => {
    const f = fixture();
    await f.session.start();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const oldRecorder = mountRecorder(f.store, f.provider);
    oldRecorder.focus();
    await flush();
    await f.session.dispose();
    const replacement = new ShortcutSession(f.store, f.provider, vi.fn(), vi.fn(), "darwin");
    cleanups.push(() => replacement.dispose());
    await replacement.start();
    const newToken = replacement.beginRecording();
    await flush();
    window.dispatchEvent(new Event("blur"));
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      false,
      expect.any(Array),
    );
    oldRecorder.unmount();
    expect(removeWindow).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    const calls = vi.mocked(f.provider.replace).mock.calls.length;
    window.dispatchEvent(new Event("blur"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(f.provider.replace).toHaveBeenCalledTimes(calls);
    await replacement.endRecording(newToken);
    expect(f.provider.replace).toHaveBeenLastCalledWith(
      expect.any(Number),
      true,
      expect.any(Array),
    );
    removeWindow.mockRestore();
    removeDocument.mockRestore();
  });

  it("晚返回注册不会覆盖新开关或执行旧回调，dispose等待返回再teardown", async () => {
    const f = fixture();
    let resolve!: (status: GlobalShortcutStatus) => void;
    vi.mocked(f.provider.replace).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const start = f.session.start();
    await flush();
    f.store.globalOpen = false;
    resolve({ generation: 42, enabled: true, suspended: false, results: [] });
    await start;
    f.emit(42);
    expect(f.execute).not.toHaveBeenCalled();
    await flush();
    expect(f.provider.replace).toHaveBeenLastCalledWith(42, false, expect.any(Array));
    await f.session.dispose();
    expect(f.provider.teardown).toHaveBeenCalledOnce();
    expect(f.callbacks.size).toBe(0);
    await f.session.dispose();
    expect(f.provider.teardown).toHaveBeenCalledOnce();
  });

  it("注册失败显示兼容错误字段，disabled清除错误，不以check伪报系统占用", async () => {
    const f = fixture();
    vi.mocked(f.provider.replace).mockResolvedValueOnce({
      generation: 7,
      enabled: true,
      suspended: false,
      results: [
        {
          action: "playOrPause",
          accelerator: "bad",
          normalized: "",
          status: "invalid",
          error: "invalid",
        },
      ],
    });
    await f.session.start();
    expect(f.store.shortcutList.playOrPause.isRegistered).toBe(true);
    expect(f.failure).toHaveBeenCalledOnce();
    f.store.globalOpen = false;
    await flush();
    expect(f.store.shortcutList.playOrPause.isRegistered).toBe(false);
    expect(f.provider.check).not.toHaveBeenCalled();
  });

  it("Electron录制沿用旧数字转换且不增加动作监听", async () => {
    const f = fixture();
    const recorder = mountRecorder(f.store, f.provider, "electron");
    recorder.focus();
    recorder.key("Digit1", { ctrlKey: true });
    expect(f.store.shortcutList.playOrPause.globalShortcut).toBe("Control+num1");
  });
});
