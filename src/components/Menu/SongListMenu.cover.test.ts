import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import type { DropdownOption } from "naive-ui";
import type { SongInfo } from "@/types/main.hemusic";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import { useLocalArtwork } from "@/composables/useLocalArtwork";

const state = vi.hoisted(() => ({
  settings: { showLocalCover: true },
  entries: [] as ScanEntry[],
}));
vi.mock("@/stores", () => ({ useSettingStore: () => state.settings }));
vi.mock("@/platform/filesSession", () => ({
  filesSession: { value: { ready: { value: true }, directories: { value: [{ token: "grant" }] } } },
}));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: (id: string) => state.entries.find((entry) => entry.ref.fileId === id),
}));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:1234/session" });
  state.settings = Vue.reactive({ showLocalCover: true });
  state.entries = [
    localEntry("/Music/one/song.mp3", "one"),
    localEntry("/Music/two/song.mp3", "two"),
  ];
  const getSizeCover = vi.fn(() => "https://example.com/online.jpg");
  const modules: Record<string, unknown> = {
    vue: Vue,
    "naive-ui": { NFlex: Vue.defineComponent({}), NText: Vue.defineComponent({}) },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/composables/useSongMenu": { useSongMenu: () => ({ getMenuOptions: () => [] }) },
    "@/composables/useLocalArtwork": { useLocalArtwork },
    "@/components/UI/s-image.vue": { default: "s-image" },
    "@/utils/songManager": {
      default: {
        getPlayerInfoObj: (song: SongInfo) => ({ name: song.name, artist: song.artists }),
      },
    },
    "@/utils/format": { getSizeCover },
    "@/utils/touchContextMenu": { shouldIgnoreTouchContextMenuOutside: () => false },
  };
  const { descriptor } = parse(
    readFileSync(new URL("./SongListMenu.vue", import.meta.url), "utf8"),
  );
  const script = compileScript(descriptor, { id: "SongListMenu" });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  interface MenuSetup {
    openDropdown: (event: MouseEvent, songs: SongInfo[], song: SongInfo, index: number) => void;
    dropdownOptions: Vue.Ref<DropdownOption[]>;
    dropdownShow: Vue.Ref<boolean>;
  }
  const exports: { default?: { setup: (props: object, context: object) => MenuSetup } } = {};
  new Function("require", "exports", "ref", "shallowRef", "computed", "h", "nextTick", compiled)(
    (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
    exports,
    Vue.ref,
    Vue.shallowRef,
    Vue.computed,
    Vue.h,
    Vue.nextTick,
  );
  if (!exports.default) throw new Error("Missing SongListMenu");
  const menu = exports.default.setup({}, { expose: () => {}, emit: () => {} });
  const open = async (song: SongInfo) => {
    menu.openDropdown(new MouseEvent("contextmenu"), [], song, 0);
    await Vue.nextTick();
  };
  const source = () => {
    const header = menu.dropdownOptions.value[0];
    if (typeof header.render !== "function") throw new Error("Missing menu header");
    const node = header.render();
    if (!Vue.isVNode(node)) throw new Error("Missing header node");
    const children = node.children;
    if (
      !children ||
      typeof children !== "object" ||
      !("default" in children) ||
      typeof children.default !== "function"
    )
      throw new Error("Missing header content");
    const images: unknown = children.default();
    if (!Array.isArray(images) || !Vue.isVNode(images[0])) throw new Error("Missing cover");
    return images[0].props?.src;
  };
  // The menu only reads the event coordinates and prevents its default action.
  vi.stubGlobal(
    "MouseEvent",
    class {
      clientX = 10;
      clientY = 20;
      preventDefault = vi.fn();
    },
  );
  return { menu, open, source, getSizeCover };
}

it("shows the selected local file's artwork and updates it when another menu opens", async () => {
  const f = fixture();
  await f.open(localSong(state.entries[0]));
  expect(new URL(f.source()).searchParams.get("path")).toBe("/Music/one/song.mp3");
  await f.open(localSong(state.entries[1]));
  expect(new URL(f.source()).searchParams.get("path")).toBe("/Music/two/song.mp3");
  expect(f.getSizeCover).not.toHaveBeenCalled();
  f.menu.dropdownShow.value = false;
  expect(f.source()).toBe("/images/song.jpg?asset");
});

it("uses the existing cover when local artwork is disabled or unavailable", async () => {
  const f = fixture();
  state.settings.showLocalCover = false;
  await f.open(localSong(state.entries[0]));
  expect(f.source()).toBe("/images/song.jpg?asset");
  state.settings.showLocalCover = true;
  state.entries = [];
  expect(f.source()).toBe("/images/song.jpg?asset");
  expect(f.getSizeCover).not.toHaveBeenCalled();
});

it("keeps online songs using the platform cover", async () => {
  const f = fixture();
  await f.open({ ...localSong(state.entries[0]), path: undefined, platform: "online" });
  expect(f.source()).toBe("https://example.com/online.jpg");
  expect(f.getSizeCover).toHaveBeenCalled();
});
