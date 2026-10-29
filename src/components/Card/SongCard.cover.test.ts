import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import type { SongInfo } from "@/types/main.hemusic";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

function fixture(electron: boolean) {
  const song: SongInfo = Vue.reactive({
    id: "mygo-local:song",
    path: "song.mp3",
    platform: "local",
    name: "song",
    subtitle: "",
    artists: "",
    album: "",
    duration: 0,
    mv_id: "",
    links: [],
    cover: "",
  });
  const settings = Vue.reactive({ showLocalCover: true });
  const artwork = Vue.shallowRef<string>();
  let enabled: Vue.Ref<boolean> | undefined;
  const invoke = vi.fn(async () => ({ data: [], format: "image/jpeg" }));
  vi.stubGlobal("window", { electron: { ipcRenderer: { invoke } } });
  const { descriptor } = parse(readFileSync(new URL("./SongCard.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "SongCard", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    vue: {
      ...Vue,
      resolveComponent: (name: string) => name,
      renderSlot: () => Vue.createCommentVNode("slot"),
    },
    "@/stores": {
      useDataStore: () => ({ isLikeSong: () => false }),
      useMusicStore: () => ({ playSong: { id: "other" } }),
      usePlatformStore: () => ({ isFeatureSupport: () => false }),
      useStatusStore: () => ({ playStatus: false }),
      useSettingStore: () => settings,
    },
    "@/utils/helper": { formatFileSize: () => "" },
    "@/utils/modal": { openJumpArtist: vi.fn() },
    "@/utils/auth": { toLikeSong: vi.fn() },
    "lodash-es": { isObject: (value: unknown) => typeof value === "object" },
    "@/utils/time": { secondsToTime: () => "0" },
    "@/utils/player": { usePlayer: () => ({}) },
    "@/utils/blob": { default: { createBlobURL: () => "blob:electron" } },
    "@/utils/format": { getSizeCover: () => "online" },
    "@/utils/song": { songEqual: () => false, IsValidId: () => false },
    "@/api/platform": { FeatureSupportFlag: {} },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@/utils/env": { isElectron: electron },
    "@/composables/useMobile": { useMobile: () => ({ isSmallScreen: false }) },
    "@/composables/useLocalArtwork": {
      useLocalArtwork: (_song: unknown, active: Vue.Ref<boolean>) => {
        enabled = active;
        return { url: artwork };
      },
    },
  };
  const exports: {
    default?: {
      setup: (props: object, context: object) => (ctx: object, cache: unknown[]) => Vue.VNode;
    };
  } = {};
  new Function("require", "exports", "useRouter", compiled)(
    (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
    exports,
    () => ({}),
  );
  if (!exports.default) throw new Error("Missing SongCard candidate");
  const scope = Vue.effectScope();
  const render = scope.run(() =>
    exports.default!.setup(Vue.reactive({ song, index: 0 }), {
      expose: () => {},
      emit: () => {},
      slots: {},
    }),
  )!;
  cleanups.push(() => scope.stop());
  const all = (value: Vue.VNode): Vue.VNode[] => [
    value,
    ...(Array.isArray(value.children) ? value.children.filter(Vue.isVNode).flatMap(all) : []),
  ];
  const image = () => all(render({ $slots: {} }, [])).find((node) => node.type === "s-image");
  return { song, settings, artwork, invoke, image, enabled: () => enabled?.value };
}

it("SongCard candidate gates native artwork with visibility and keeps song data unchanged", async () => {
  const h = fixture(false);
  expect(h.enabled()).toBe(false);
  const image = h.image();
  expect(typeof image?.props?.["onUpdate:show"]).toBe("function");
  await image!.props!["onUpdate:show"](true);
  expect(h.enabled()).toBe(true);
  h.artwork.value = "blob:native";
  expect(h.image()?.props?.src).toBe("blob:native");
  expect(h.song.cover).toBe("");
  expect(h.invoke).not.toHaveBeenCalled();
  h.settings.showLocalCover = false;
  expect(h.enabled()).toBe(false);
  expect(h.image()).toBeUndefined();
});

it("SongCard candidate retains the existing Electron cover fallback", async () => {
  const h = fixture(true);
  await h.image()!.props!["onUpdate:show"](true);
  expect(h.invoke).toHaveBeenCalledWith("get-music-cover", "song.mp3");
  expect(h.song.cover).toBe("blob:electron");
  expect(h.image()?.props?.src).toBe("blob:electron");
});
