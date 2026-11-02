import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import type { PlatformAdapter } from "./types";
import type { PlatformFiles } from "./files";
import type { SettingGroup, SettingConfig } from "@/types/settings";
import type { SettingsImportResult } from "./mygo.bindings";
import * as settingLifecycle from "@/composables/useSettingLifecycle";

const host = vi.hoisted(() => ({ electron: false }));
vi.mock("@/utils/env", () => ({
  get isElectron() {
    return host.electron;
  },
  get isMygo() {
    return !host.electron;
  },
}));
vi.mock("@/utils/modal", () => ({
  openFontManager: vi.fn(),
  openThemeConfig: vi.fn(),
  openExcludeLyric: vi.fn(),
  openLocalMusicDirectoryModal: vi.fn(),
}));
vi.mock("@/utils/helper", () => ({
  renderIcon: vi.fn(),
  renderOption: vi.fn(),
  shuffleArray: vi.fn(),
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => ({}) }));
vi.mock("@/components/Setting/components/LyricPreview.vue", () => ({ default: {} }));
vi.mock("@/components/Setting/components/ShortcutRecorder.vue", () => ({ default: {} }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  ...(await import("@/stores/shortcut")),
  ...(await import("@/stores/status")),
  useDataStore: () => ({ deleteDB: vi.fn() }),
}));
vi.mock("@/platform", () => ({ platform }));
vi.mock("@/i18n", () => ({ t: (key: string) => `${locale.value}:${key}` }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => `${locale.value}:${key}` }) }));
const locale = Vue.ref("zh-CN");
const platform: { -readonly [K in keyof PlatformAdapter]: PlatformAdapter[K] } = {
  kind: "mygo",
  os: "darwin",
  capabilities: {
    windowControls: false,
    tray: false,
    desktopLyrics: false,
    localMusic: false,
    electronStartup: false,
  },
  window: null,
  openExternal: async () => {},
};
vi.stubGlobal("localStorage", {});
const { useSettingStore } = await import("@/stores/setting");
const generalModule = await import("@/components/Setting/config/general");
const generalActionsModule = await import("@/components/Setting/config/generalActions");
const playModule = await import("@/components/Setting/config/play");
const appearanceModule = await import("@/components/Setting/config/appearance");
const lyricModule = await import("@/components/Setting/config/lyric");
const keyboardModule = await import("@/components/Setting/config/keyboard");
const localModule = await import("@/components/Setting/config/local");
const networkModule = await import("@/components/Setting/config/network");
const { FilesSession, filesSession } = await import("./filesSession");
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function provider(): PlatformFiles {
  return {
    begin: vi.fn(async () => ({ epoch: 1 })),
    chooseDirectory: vi.fn(),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(),
    teardown: vi.fn(async () => {}),
    importSettings: vi.fn<PlatformFiles["importSettings"]>(async () => ({
      status: "selected",
      document: {
        format: "he-music-renderer-settings",
        version: 1,
        renderer: { "setting-store": '{"language":"en"}', "shortcut-store": "{}" },
      },
    })),
    exportSettings: vi.fn<PlatformFiles["exportSettings"]>(async () => ({ status: "saved" })),
  };
}
type Dialog = {
  onPositiveClick?: () => unknown;
  onNegativeClick?: () => unknown;
  content?: string;
};
let confirmation: Dialog;
const messages = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
const reload = vi.fn();
const electronImport = vi.fn<() => Promise<unknown>>();
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  locale.value = "zh-CN";
  host.electron = false;
  platform.kind = "mygo";
  platform.files = undefined;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  });
  vi.stubGlobal("window", {
    location: { reload },
    $message: messages,
    $dialog: {
      warning: vi.fn((dialog: Dialog) => {
        confirmation = dialog;
      }),
    },
    api: { store: { import: electronImport, export: vi.fn(async () => true) } },
    electron: { ipcRenderer: { invoke: vi.fn(async () => undefined), on: vi.fn(), send: vi.fn() } },
  });
  // Stand in for the existing auto-import build transform, without changing SFC connections.
  for (const name of [
    "computed",
    "ref",
    "reactive",
    "watch",
    "toValue",
    "nextTick",
    "onMounted",
    "markRaw",
  ] as const) {
    vi.stubGlobal(name, Vue[name]);
  }
});
afterEach(async () => {
  cleanups.splice(0).forEach((close) => close());
  await filesSession.value?.dispose();
  await flush();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mountPage(type: "general" | "lyrics" = "lyrics") {
  // Compile the production script AND inline template; no extracted/recreated computed wiring.
  const { descriptor } = parse(
    readFileSync(new URL("../components/Setting/MainSetting.vue", import.meta.url), "utf8"),
  );
  const compiled = compileScript(descriptor, { id: "MainSetting.vue", inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pass = Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { slots }) {
      return () => slots.default?.();
    },
  });
  const lyricConfigs: SettingConfig[] = [];
  const modules: Record<string, unknown> = {
    vue: { ...Vue, Transition: pass },
    "@/composables/useSettingLifecycle": settingLifecycle,
    "vue-i18n": { useI18n: () => ({ t: (key: string) => `${locale.value}:${key}` }) },
    "@/composables/useMobile": { useMobile: () => ({ isSmallScreen: Vue.ref(false) }) },
    "@/utils/helper": { renderIcon: () => undefined },
    "@/utils/env": {
      get isElectron() {
        return host.electron;
      },
    },
    "@/../package.json": { default: { author: "Synthetic", version: "0" } },
    "./config/generalActions": generalActionsModule,
    "./config/general": generalModule,
    "./config/play": playModule,
    "./config/appearance": appearanceModule,
    "./config/lyric": {
      useLyricSettings: () => {
        const config = lyricModule.useLyricSettings();
        lyricConfigs.push(config);
        return config;
      },
    },
    "./config/keyboard": keyboardModule,
    "./config/local": localModule,
    "./config/network": networkModule,
  };
  const exports: { default?: Vue.Component } = {};
  new Function("require", "exports", code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected MainSetting import ${name}`);
    return modules[name];
  }, exports);
  let groups: SettingGroup[] = [];
  let search: Array<{ value?: unknown; label?: unknown }> = [];
  let selectMenu: (key: string) => void = () => {
    throw new Error("Menu has not rendered");
  };
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({ style: {} }),
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
  const app = renderer.createApp(exports.default!, { type });
  for (const name of ["NFlex", "NH1", "NScrollbar", "NText", "NButton", "SvgIcon", "AboutSetting"])
    app.component(name, pass);
  app.component(
    "SettingSearch",
    Vue.defineComponent({
      props: ["options"],
      setup(props) {
        return () => {
          search = props.options;
          return null;
        };
      },
    }),
  );
  app.component(
    "UniversalSetting",
    Vue.defineComponent({
      props: ["groups"],
      setup(props) {
        return () => {
          groups = props.groups;
          return null;
        };
      },
    }),
  );
  app.component(
    "NMenu",
    Vue.defineComponent({
      props: ["value", "options"],
      emits: ["update:value"],
      setup(_props, { emit }) {
        selectMenu = (key) => emit("update:value", key);
        return () => null;
      },
    }),
  );
  app.mount({});
  let closed = false;
  const close = () => {
    if (!closed) app.unmount();
    closed = true;
  };
  cleanups.push(close);
  const item = (key: string) =>
    groups.flatMap((group) => group.items).find((item) => item.key === key)!;
  return {
    close,
    lyricConfigs,
    item,
    search: () => search,
    general: async () => {
      selectMenu("general");
      await flush();
    },
    import: () => item("importSettings").action?.(),
    disabled: () => Vue.toValue(item("importSettings").disabled),
  };
}

describe("MainSetting production lazy search/config ownership", () => {
  it("owns style watchers created by lazy search from the general entry and replaces them on locale changes", async () => {
    const store = useSettingStore();
    const page = mountPage("general");
    const styleValue = (config: SettingConfig | undefined) => {
      const value = config?.groups
        .flatMap((group) => group.items)
        .find((item) => item.key === "desktopLyricPlayedColor")?.value;
      if (!value) throw new Error("Missing style configuration");
      return value;
    };
    const first = styleValue(page.lyricConfigs[0]);
    store.desktopLyricStyle.playedColor = "#123456";
    expect(first.value).toBe("#123456");
    locale.value = "en";
    await flush();
    const current = styleValue(page.lyricConfigs.at(-1));
    expect(current).not.toBe(first);
    store.desktopLyricStyle.playedColor = "#abcdef";
    expect(current.value).toBe("#abcdef");
    expect(first.value).toBe("#123456");
    page.close();
    store.desktopLyricStyle.playedColor = "#fff";
    expect(current.value).toBe("#abcdef");
    expect(first.value).toBe("#123456");
  });
  it.each(["mygo", "electron"] as const)(
    "cancels %s successful import reload when a lyrics-entry page closes",
    async (kind) => {
      const native = provider();
      platform.files = kind === "mygo" ? native : undefined;
      platform.kind = kind;
      host.electron = kind === "electron";
      if (kind === "mygo") await new FilesSession(native).start();
      electronImport.mockResolvedValue({
        renderer: { "setting-store": "{}", "shortcut-store": "{}" },
      });
      const page = mountPage();
      expect(page.search().some((option) => option.value === "general::importSettings")).toBe(true);
      await page.general();
      page.import();
      await confirmation.onPositiveClick?.();
      expect(localStorage.setItem).toHaveBeenCalledTimes(2);
      page.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      expect(native.teardown).not.toHaveBeenCalled();
    },
  );
  it.each(["mygo", "electron"] as const)(
    "ignores %s old confirmation after unmount",
    async (kind) => {
      const native = provider();
      platform.files = kind === "mygo" ? native : undefined;
      platform.kind = kind;
      host.electron = kind === "electron";
      if (kind === "mygo") await new FilesSession(native).start();
      const page = mountPage();
      await page.general();
      page.import();
      page.close();
      await confirmation.onPositiveClick?.();
      expect(native.importSettings).not.toHaveBeenCalled();
      expect(electronImport).not.toHaveBeenCalled();
    },
  );
  it.each(["mygo", "electron"] as const)(
    "ignores %s pending import results after unmount",
    async (kind) => {
      const native = provider();
      platform.files = kind === "mygo" ? native : undefined;
      platform.kind = kind;
      host.electron = kind === "electron";
      const session = kind === "mygo" ? new FilesSession(native) : undefined;
      await session?.start();
      const panel = deferred<SettingsImportResult>();
      const electronPanel = deferred<unknown>();
      native.importSettings = vi.fn(() => panel.promise);
      electronImport.mockReturnValue(electronPanel.promise);
      const page = mountPage();
      await page.general();
      page.import();
      const done = confirmation.onPositiveClick?.();
      expect(kind === "mygo" ? native.importSettings : electronImport).toHaveBeenCalledTimes(1);
      page.close();
      panel.resolve({
        status: "selected",
        document: {
          format: "he-music-renderer-settings",
          version: 1,
          renderer: { "setting-store": "{}", "shortcut-store": "{}" },
        },
      });
      electronPanel.resolve({ renderer: { "setting-store": "{}", "shortcut-store": "{}" } });
      await done;
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(messages.success).not.toHaveBeenCalled();
      expect(messages.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      expect(native.teardown).not.toHaveBeenCalled();
      if (session) expect(filesSession.value).toBe(session);
    },
  );
  it.each(["mygo", "electron"] as const)(
    "ignores %s pending import errors after unmount",
    async (kind) => {
      const native = provider();
      platform.files = kind === "mygo" ? native : undefined;
      platform.kind = kind;
      host.electron = kind === "electron";
      if (kind === "mygo") await new FilesSession(native).start();
      const gate = deferred<void>();
      native.importSettings = vi.fn(async () => {
        await gate.promise;
        throw new Error("synthetic host failure");
      });
      electronImport.mockImplementation(async () => {
        await gate.promise;
        throw new Error("synthetic host failure");
      });
      const page = mountPage();
      await page.general();
      page.import();
      const done = confirmation.onPositiveClick?.();
      page.close();
      gate.resolve();
      await done;
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(messages.success).not.toHaveBeenCalled();
      expect(messages.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      expect(native.teardown).not.toHaveBeenCalled();
    },
  );
  it.each(["mygo", "electron"] as const)(
    "keeps %s controller identity and pending panel while locale recomputes labels/search",
    async (kind) => {
      const native = provider();
      platform.files = kind === "mygo" ? native : undefined;
      platform.kind = kind;
      host.electron = kind === "electron";
      if (kind === "mygo") await new FilesSession(native).start();
      const page = mountPage();
      await page.general();
      page.import();
      const first = confirmation;
      const action = page.item("importSettings").action;
      const disabled = page.item("importSettings").disabled;
      locale.value = "en";
      useSettingStore().language = "en";
      await flush();
      expect(page.item("importSettings").label).toBe("en:setting.other.import_settings");
      expect(
        page.search().find((option) => option.value === "general::importSettings")?.label,
      ).toBe("en:setting.other.import_settings");
      expect(page.item("importSettings").action).toBe(action);
      expect(page.item("importSettings").disabled).toBe(disabled);
      expect(page.disabled()).toBe(true);
      page.import();
      expect(window.$dialog.warning).toHaveBeenCalledTimes(1);
      expect(confirmation).toBe(first);
      first.onNegativeClick?.();
      expect(page.disabled()).toBe(false);
      const panel = deferred<SettingsImportResult>();
      const electronPanel = deferred<unknown>();
      native.importSettings = vi.fn(() => panel.promise);
      electronImport.mockReturnValue(electronPanel.promise);
      page.import();
      const done = confirmation.onPositiveClick?.();
      locale.value = "zh-CN";
      useSettingStore().language = "zh-CN";
      await flush();
      expect(page.item("importSettings").label).toBe("zh-CN:setting.other.import_settings");
      expect(page.disabled()).toBe(true);
      page.import();
      expect(window.$dialog.warning).toHaveBeenCalledTimes(2);
      expect(kind === "mygo" ? native.importSettings : electronImport).toHaveBeenCalledTimes(1);
      panel.resolve({
        status: "selected",
        document: {
          format: "he-music-renderer-settings",
          version: 1,
          renderer: { "setting-store": "{}", "shortcut-store": "{}" },
        },
      });
      electronPanel.resolve({ renderer: { "setting-store": "{}", "shortcut-store": "{}" } });
      await done;
      expect(page.disabled()).toBe(true);
      page.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      expect(native.teardown).not.toHaveBeenCalled();
    },
  );
});
