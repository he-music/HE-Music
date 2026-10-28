import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { createPinia, setActivePinia } from "pinia";
type DialogCallbacks = {
  onPositiveClick?: () => unknown;
  onNegativeClick?: () => unknown;
  onAfterLeave?: () => unknown;
};
import type { PlatformAdapter } from "./types";
import type { PlatformFiles } from "./files";
import type { RendererSettingsDocument, SettingsImportResult } from "./mygo.bindings";

const host = vi.hoisted(
  (): {
    platform: { -readonly [K in keyof PlatformAdapter]: PlatformAdapter[K] };
    electron: boolean;
  } => ({
    platform: {
      kind: "mygo",
      os: "darwin",
      capabilities: {
        windowControls: true,
        tray: false,
        desktopLyrics: false,
        localMusic: false,
        electronStartup: false,
      },
      window: null,
      openExternal: async () => {},
    },
    electron: false,
  }),
);
vi.mock("@/platform", () => ({ platform: host.platform }));
vi.mock("@/utils/env", () => ({
  get isElectron() {
    return host.electron;
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/player", () => ({ usePlayer: () => ({}) }));
vi.mock("@/utils/format", () => ({ getSizeCover: vi.fn() }));
vi.mock("@/utils/blob", () => ({ default: {} }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/utils/helper", () => ({ shuffleArray: vi.fn() }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/setting")),
  ...(await import("@/stores/shortcut")),
  ...(await import("@/stores/status")),
  ...(await import("@/stores/music")),
  useDataStore: () => ({
    deleteDB: vi.fn(),
    userData: { id: "" },
    userLoginStatus: false,
    isLikeSong: () => false,
  }),
}));
vi.stubGlobal("localStorage", {});
const { useSettingStore, useShortcutStore, useStatusStore } = await import("@/stores");
const { useGeneralSettings } = await import("@/components/Setting/config/general");
const { useGeneralSettingsActions } = await import("@/components/Setting/config/generalActions");
const { useDesktopLifecycle } = await import("@/composables/useDesktopLifecycle");
const { FilesSession, filesSession } = await import("./filesSession");
const scopes: Array<() => void> = [];
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
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
    importSettings: vi.fn<PlatformFiles["importSettings"]>(async () => ({
      status: "cancelled",
      document: null,
    })),
    exportSettings: vi.fn<PlatformFiles["exportSettings"]>(async () => ({ status: "saved" })),
    teardown: vi.fn(async () => {}),
  };
}
function document(setting = "{}", shortcut = "{}"): RendererSettingsDocument {
  return {
    format: "he-music-renderer-settings",
    version: 1,
    renderer: { "setting-store": setting, "shortcut-store": shortcut },
  };
}
let confirm: DialogCallbacks;
let calls: number;
let failures: number[];
let values: Map<string, string>;
const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
const reload = vi.fn();
const electronExport = vi.fn(async () => true);
const electronImport = vi.fn(async () => ({ renderer: document().renderer }));
beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  Object.assign(host.platform, {
    kind: "mygo",
    lifecycle: undefined,
    files: undefined,
    systemMedia: undefined,
    shortcuts: undefined,
    capabilities: { tray: false },
  });
  host.electron = false;
  values = new Map();
  calls = 0;
  failures = [];
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      if (failures.includes(++calls)) throw new Error("quota");
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  });
  vi.stubGlobal("window", {
    $message: messages,
    $dialog: {
      warning: vi.fn((options: DialogCallbacks) => {
        confirm = options;
      }),
    },
    location: { reload },
    api: { store: { export: electronExport, import: electronImport } },
  });
});
afterEach(async () => {
  scopes.splice(0).forEach((off) => off());
  await filesSession.value?.dispose();
  await flush();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function general() {
  const scope = Vue.effectScope();
  scopes.push(() => scope.stop());
  const config = scope.run(() => useGeneralSettings(useGeneralSettingsActions()))!;
  const item = (key: string) =>
    config.groups.flatMap((group) => group.items).find((item) => item.key === key)!;
  return {
    scope,
    config,
    item,
    export: () => item("exportSettings").action?.(),
    import: () => item("importSettings").action?.(),
    disabled: () => Vue.toValue(item("exportSettings").disabled),
  };
}
function mountShell() {
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
      useDesktopLifecycle({ showCloseModal: Vue.ref(false), rememberNotAsk: Vue.ref(false) });
      return () => null;
    },
  });
  app.mount({});
  let closed = false;
  const stop = () => {
    if (!closed) app.unmount();
    closed = true;
  };
  scopes.push(stop);
  return stop;
}
function lifecycle(ready = Promise.resolve({ trayAvailable: false, epoch: 1 })) {
  const result = {
    ready: vi.fn(() => ready),
    syncConfig: vi.fn(async () => {}),
    syncPlayback: vi.fn(async () => {}),
    acknowledgeClose: vi.fn(async () => {}),
    resolveClose: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
    hide: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    onCloseRequested: () => () => {},
    onTrayAction: () => () => {},
  };
  host.platform.lifecycle = result;
  return result;
}

describe("actual General settings file actions", () => {
  it.each(["web", "electron"] as const)(
    "does not call native files on %s without provider",
    async (kind) => {
      host.platform.kind = kind;
      host.electron = kind === "electron";
      const page = general();
      await page.export();
      expect(filesSession.value).toBeUndefined();
      expect(electronExport).toHaveBeenCalledTimes(kind === "electron" ? 1 : 0);
      expect(
        Vue.toValue(
          page.config.groups.find((group) =>
            group.items.some((item) => item.key === "exportSettings"),
          )!.show,
        ),
      ).toBe(kind === "electron");
    },
  );
  it("enables only after begin and exports live two-store Pinia state without storage or native secrets", async () => {
    const native = provider();
    host.platform.files = native;
    const page = general();
    expect(page.disabled()).toBe(true);
    const session = new FilesSession(native);
    await session.start();
    expect(page.disabled()).toBe(false);
    useSettingStore().language = "en";
    useShortcutStore().globalOpen = false;
    await page.export();
    expect(native.exportSettings).toHaveBeenCalledTimes(1);
    const snapshot = vi.mocked(native.exportSettings).mock.calls[0][1];
    expect(Object.keys(snapshot)).toEqual(["setting-store", "shortcut-store"]);
    expect(JSON.parse(snapshot["setting-store"]).language).toBe("en");
    expect(JSON.parse(snapshot["shortcut-store"]).globalOpen).toBe(false);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(electronExport).not.toHaveBeenCalled();
    expect(electronImport).not.toHaveBeenCalled();
    expect(messages.success).toHaveBeenCalledWith("message.export_settings_success");
  });
  it("rejects double clicks, handles cancellation silently, and recovers after a failure", async () => {
    const native = provider();
    host.platform.files = native;
    const session = new FilesSession(native);
    await session.start();
    const panel = deferred<Awaited<ReturnType<PlatformFiles["exportSettings"]>>>();
    native.exportSettings = vi.fn(() => panel.promise);
    const page = general();
    const first = page.export();
    await page.export();
    expect(page.disabled()).toBe(true);
    expect(native.exportSettings).toHaveBeenCalledTimes(1);
    panel.resolve({ status: "cancelled" });
    await first;
    expect(messages.success).not.toHaveBeenCalled();
    expect(messages.error).not.toHaveBeenCalled();
    vi.mocked(native.exportSettings).mockRejectedValueOnce(new Error("host-secret"));
    await page.export();
    expect(messages.error).toHaveBeenCalledWith("message.settings_file_failed");
    expect(page.disabled()).toBe(false);
  });
  it("ignores stale confirmations and import results after the page closes without tearing down shared session", async () => {
    const native = provider();
    host.platform.files = native;
    const session = new FilesSession(native);
    await session.start();
    let page = general();
    page.import();
    page.scope.stop();
    await confirm.onPositiveClick?.();
    expect(native.importSettings).not.toHaveBeenCalled();
    page = general();
    const panel = deferred<SettingsImportResult>();
    native.importSettings = vi.fn(() => panel.promise);
    page.import();
    const done = confirm.onPositiveClick?.();
    page.scope.stop();
    panel.resolve({ status: "selected", document: document() });
    await done;
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(messages.success).not.toHaveBeenCalled();
    expect(native.teardown).not.toHaveBeenCalled();
    expect(filesSession.value).toBe(session);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
  });
  it("validates the second store before writes and reports quota/rollback failures without reload", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    vi.mocked(native.importSettings).mockResolvedValue({
      status: "selected",
      document: document("{}", '{"globalOpen":"bad"}'),
    });
    page.import();
    await confirm.onPositiveClick?.();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    vi.mocked(native.importSettings).mockResolvedValue({
      status: "selected",
      document: document(),
    });
    values.set("setting-store", "old1");
    values.set("shortcut-store", "old2");
    failures = [2];
    page.import();
    await confirm.onPositiveClick?.();
    expect([...values.values()]).toEqual(["old1", "old2"]);
    calls = 0;
    failures = [2, 3];
    page.import();
    await confirm.onPositiveClick?.();
    expect(messages.error).toHaveBeenCalledWith("message.settings_restore_failed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).not.toHaveBeenCalled();
  });
  it("imports once, locks the reload interval and cancels reload on scope disposal", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    vi.mocked(native.importSettings).mockResolvedValue({
      status: "selected",
      document: document('{"language":"en"}'),
    });
    page.import();
    const callback = confirm.onPositiveClick;
    await callback?.();
    await callback?.();
    expect(native.importSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("setting-store")!).language).toBe("en");
    expect(page.disabled()).toBe(true);
    await page.export();
    expect(native.exportSettings).not.toHaveBeenCalled();
    page.scope.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    expect(native.teardown).not.toHaveBeenCalled();
  });
  it("reloads a successful active page once", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    vi.mocked(native.importSettings).mockResolvedValue({
      status: "selected",
      document: document(),
    });
    page.import();
    await confirm.onPositiveClick?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("treats import cancellation and negative confirmation silently", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    page.import();
    confirm.onNegativeClick?.();
    expect(page.disabled()).toBe(false);
    page.import();
    await confirm.onPositiveClick?.();
    expect(messages.success).not.toHaveBeenCalled();
    expect(messages.error).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(page.disabled()).toBe(false);
  });
  it("reports native Busy for export and import without a generic failure", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    vi.mocked(native.exportSettings).mockRejectedValueOnce(
      new Error("native file operation is busy"),
    );
    await page.export();
    expect(messages.warning).toHaveBeenCalledExactlyOnceWith("message.settings_file_busy");
    expect(page.disabled()).toBe(false);
    vi.mocked(native.importSettings).mockRejectedValueOnce(
      new Error("native file operation is busy"),
    );
    page.import();
    await confirm.onPositiveClick?.();
    expect(messages.warning).toHaveBeenCalledTimes(2);
    expect(messages.warning).toHaveBeenLastCalledWith("message.settings_file_busy");
    expect(messages.error).not.toHaveBeenCalled();
    expect(page.disabled()).toBe(false);
  });
  it("ignores a late saved result after session replacement", async () => {
    const native = provider();
    host.platform.files = native;
    const panel = deferred<Awaited<ReturnType<PlatformFiles["exportSettings"]>>>();
    native.exportSettings = vi.fn(() => panel.promise);
    const session = new FilesSession(native);
    await session.start();
    const page = general();
    const exporting = page.export();
    await session.dispose();
    const replacement = new FilesSession(provider());
    await replacement.start();
    panel.resolve({ status: "saved" });
    await exporting;
    expect(messages.success).not.toHaveBeenCalled();
    expect(messages.error).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(filesSession.value).toBe(replacement);
  });
  it("does not let a cancelled confirmation affect its replacement", async () => {
    const native = provider();
    host.platform.files = native;
    await new FilesSession(native).start();
    const page = general();
    page.import();
    const old = confirm;
    old.onNegativeClick?.();
    expect(page.disabled()).toBe(false);
    page.import();
    const next = confirm;
    await old.onPositiveClick?.();
    old.onAfterLeave?.();
    expect(native.importSettings).not.toHaveBeenCalled();
    expect(page.disabled()).toBe(true);
    next.onNegativeClick?.();
    expect(page.disabled()).toBe(false);
  });
});

describe("actual desktop lifecycle file setup", () => {
  it("does not begin before Ready, and does not react to playback clocks", async () => {
    const native = provider();
    host.platform.files = native;
    const ready = deferred<{ trayAvailable: boolean; epoch: number }>();
    lifecycle(ready.promise);
    const stop = mountShell();
    await flush();
    expect(native.begin).not.toHaveBeenCalled();
    ready.resolve({ trayAvailable: false, epoch: 1 });
    await flush();
    expect(native.begin).toHaveBeenCalledTimes(1);
    const status = useStatusStore();
    for (let i = 0; i < 50; i++) {
      status.currentTime = i;
      status.progress = i;
    }
    await flush();
    expect(native.begin).toHaveBeenCalledTimes(1);
    const panel = deferred<SettingsImportResult>();
    native.importSettings = vi.fn(() => panel.promise);
    const operation = filesSession.value!.importSettings();
    stop();
    expect(filesSession.value).toBeUndefined();
    expect(native.teardown).toHaveBeenCalledWith(1);
    await flush();
    panel.resolve({ status: "cancelled", document: null });
    expect(await operation).toEqual({ status: "stale" });
  });
  it("serializes unknown begin cleanup before replacement Ready on the same Page", async () => {
    const native = provider();
    host.platform.files = native;
    const life = lifecycle();
    const gate = deferred<void>();
    let epoch = 0;
    let next = 0;
    native.begin = vi.fn(async () => {
      await gate.promise;
      epoch ||= ++next;
      return { epoch };
    });
    native.teardown = vi.fn(async (old) => {
      if (old === epoch) epoch = 0;
    });
    const stop = mountShell();
    await flush();
    stop();
    mountShell();
    await flush();
    expect(life.ready).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    expect(life.ready).toHaveBeenCalledTimes(2);
    expect(epoch).toBe(2);
    expect(filesSession.value?.ready.value).toBe(true);
    expect(native.teardown).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("keeps Ready healthy when files begin fails and creates no session without provider", async () => {
    const native = provider();
    host.platform.files = native;
    const life = lifecycle();
    vi.mocked(native.begin).mockRejectedValue(new Error("private"));
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    mountShell();
    await flush();
    expect(life.syncPlayback).toHaveBeenCalled();
    expect(life.teardown).not.toHaveBeenCalled();
    expect(filesSession.value).toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith("文件会话初始化失败");
    report.mockRestore();
  });
  it.each(["web", "electron"] as const)(
    "does not create a native session in %s shell",
    async (kind) => {
      host.platform.kind = kind;
      mountShell();
      await flush();
      expect(filesSession.value).toBeUndefined();
      expect(electronExport).not.toHaveBeenCalled();
    },
  );
});
