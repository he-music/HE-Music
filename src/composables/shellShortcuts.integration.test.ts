import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, reactive, ref, shallowRef } from "vue";
import type { GlobalShortcutStatus, PlatformShortcuts } from "@/platform/shortcuts";
import type { LocalFileRef, ShortcutEvent } from "@/platform/mygo.bindings";

const mocks = vi.hoisted(() => ({
  platform: { kind: "mygo", os: "darwin", shortcuts: undefined as PlatformShortcuts | undefined },
  player: {
    playOrPause: vi.fn(async () => {}),
    nextOrPrev: vi.fn<(direction: string) => Promise<void>>(async () => {}),
    setVolume: vi.fn(),
  },
}));
const store = reactive({
  globalOpen: true,
  shortcutList: {
    playOrPause: { globalShortcut: "Ctrl+Space" },
    playPrev: { globalShortcut: "Ctrl+Left" },
    playNext: { globalShortcut: "Ctrl+Right" },
    volumeUp: { globalShortcut: "Ctrl+Up" },
    volumeDown: { globalShortcut: "Ctrl+Down" },
    toggleDesktopLyric: { globalShortcut: "Ctrl+D" },
  },
});
const music = reactive({ playSong: { id: "online", platform: "fixture", path: "" } });
const localRef = (): LocalFileRef => ({
  grantToken: "grant",
  relativePath: "A.mp3",
  fileId: "A",
  version: "1",
});
const files = shallowRef<{
  ready: ReturnType<typeof ref<boolean>>;
  directories: ReturnType<typeof ref<Array<{ token: string }>>>;
}>();
const entry = shallowRef<{ relativePath: string; ref: LocalFileRef }>();
const lyrics = shallowRef<{
  ready: ReturnType<typeof ref<boolean>>;
  window: ReturnType<typeof ref<{ visible: boolean; pending: boolean }>>;
  requestVisible: ReturnType<typeof vi.fn<(visible: boolean) => Promise<unknown>>>;
}>();
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("@/stores", () => ({ useShortcutStore: () => store, useMusicStore: () => music }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: {
    get value() {
      return files.value;
    },
  },
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: (songID: string) => (songID === "mygo-local:A" ? entry.value : undefined),
}));
vi.mock("@/platform/desktopLyricsSession", () => ({
  desktopLyricsSession: {
    get value() {
      return lyrics.value;
    },
  },
}));
import { createShellShortcutSession } from "./shellShortcuts";
const cleanups: Array<() => Promise<void>> = [];
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.clearAllMocks();
  store.globalOpen = true;
  music.playSong = { id: "online", platform: "fixture", path: "" };
  files.value = {
    ready: ref(true),
    directories: ref([{ token: "grant" }]),
  };
  entry.value = { relativePath: "A.mp3", ref: localRef() };
  lyrics.value = {
    ready: ref(true),
    window: ref({ visible: false, pending: false }),
    requestVisible: vi.fn(async () => {}),
  };
  vi.stubGlobal("window", { $message: { error: vi.fn(), warning: vi.fn() } });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});
async function fixture() {
  let listener: ((event: ShortcutEvent) => void) | undefined;
  let generation = 0;
  const provider: PlatformShortcuts = {
    actions: [
      "playOrPause",
      "playPrev",
      "playNext",
      "volumeUp",
      "volumeDown",
      "toggleDesktopLyric",
    ],
    replace: vi.fn(async (_generation, enabled, bindings): Promise<GlobalShortcutStatus> => ({
      generation: ++generation,
      enabled,
      suspended: false,
      results: bindings.map((binding) => ({
        ...binding,
        normalized: binding.accelerator,
        status: "registered",
        error: "",
      })),
    })),
    suspend: vi.fn(),
    check: vi.fn(),
    teardown: vi.fn(async () => {}),
    onAction: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };
  mocks.platform.shortcuts = provider;
  const scope = effectScope();
  const session = scope.run(createShellShortcutSession);
  if (!session) throw new Error("Missing shortcut session");
  await session.start();
  const dispose = async () => {
    await session.dispose();
    scope.stop();
  };
  cleanups.push(dispose);
  return {
    session,
    provider,
    dispose,
    emit: (action: ShortcutEvent["action"], eventGeneration = generation) =>
      listener?.({ generation: eventGeneration, action }),
  };
}
it("rejects a registered native ID whose song or entry path does not match the authorized ref", async () => {
  const f = await fixture();
  music.playSong = { id: "mygo-local:A", platform: "local", path: "other.mp3" };
  f.emit("playOrPause");
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
  music.playSong = { id: "mygo-local:A", platform: "local", path: "A.mp3" };
  entry.value = { relativePath: "other.mp3", ref: localRef() };
  f.emit("playOrPause");
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
});
it("cancels an accepted event before dispatch when registration is disabled or its binding changes", async () => {
  const f = await fixture();
  f.emit("playOrPause");
  store.globalOpen = false;
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
  store.globalOpen = true;
  await flush();
  f.emit("playOrPause");
  store.shortcutList.playOrPause.globalShortcut = "Ctrl+Alt+Space";
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
});
it("routes registered local playback actions through the real shell", async () => {
  music.playSong = { id: "mygo-local:A", platform: "local", path: "A.mp3" };
  const f = await fixture();
  f.emit("playOrPause");
  f.emit("playPrev");
  f.emit("playNext");
  await flush();
  expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
  expect(mocks.player.nextOrPrev.mock.calls.map((call) => call[0])).toEqual(["prev", "next"]);
});
it("keeps online and volume actions, rejects unregistered local paths and unknown actions", async () => {
  const f = await fixture();
  f.emit("playOrPause");
  await flush();
  expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
  music.playSong = { id: "unregistered", platform: "local", path: "A.mp3" };
  f.emit("playOrPause");
  f.emit("playNext");
  f.emit("volumeUp");
  f.emit("volumeDown");
  // Runtime payload validation must reject values outside the native union.
  Reflect.apply(f.emit, undefined, ["unknown-action"]);
  await flush();
  expect(mocks.player.playOrPause).toHaveBeenCalledOnce();
  expect(mocks.player.nextOrPrev).not.toHaveBeenCalled();
  expect(mocks.player.setVolume.mock.calls.map((call) => call[0])).toEqual(["up", "down"]);
});
it("rejects revoked, not-ready and mismatched local registrations", async () => {
  music.playSong = { id: "mygo-local:A", platform: "local", path: "A.mp3" };
  const f = await fixture();
  if (!files.value || !entry.value) throw new Error("Missing fixture");
  files.value.ready.value = false;
  f.emit("playOrPause");
  files.value.ready.value = true;
  files.value.directories.value = [];
  f.emit("playOrPause");
  files.value.directories.value = [{ token: "grant" }];
  entry.value = { relativePath: "A.mp3", ref: { ...localRef(), relativePath: "other.mp3" } };
  f.emit("playOrPause");
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
});
it("toggles lyrics without a selected song and uses authoritative native window state", async () => {
  music.playSong = { id: "", platform: "", path: "" };
  const f = await fixture();
  if (!lyrics.value) throw new Error("Missing lyrics");
  Reflect.apply(f.emit, undefined, ["toggleDesktopLyric"]);
  await flush();
  expect(lyrics.value.requestVisible).toHaveBeenCalledExactlyOnceWith(true);
  lyrics.value.window.value = { visible: true, pending: false };
  Reflect.apply(f.emit, undefined, ["toggleDesktopLyric"]);
  await flush();
  expect(lyrics.value.requestVisible).toHaveBeenLastCalledWith(false);
});
it("does not act on a stale generation or disposed shell", async () => {
  const f = await fixture();
  f.emit("playOrPause", 0);
  await f.dispose();
  f.emit("playOrPause");
  Reflect.apply(f.emit, undefined, ["toggleDesktopLyric"]);
  await flush();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
  expect(lyrics.value?.requestVisible).not.toHaveBeenCalled();
});
