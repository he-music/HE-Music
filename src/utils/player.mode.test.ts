import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import type { TrayPlaybackState } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

const mocks = vi.hoisted(() => ({
  mygo: true,
  values: new Map<string, Map<string, unknown>>(),
  write: vi.fn<(name: string, key: string, value: unknown) => Promise<void>>(),
  read: vi.fn<(name: string, key: string) => Promise<void>>(),
  warning: vi.fn(),
}));
function bucket(name: string) {
  let value = mocks.values.get(name);
  if (!value) {
    value = new Map();
    mocks.values.set(name, value);
  }
  return value;
}
vi.mock("localforage", () => ({
  default: {
    createInstance: ({ name }: { name: string }) => ({
      getItem: async (key: string) => {
        await mocks.read(name, key);
        return bucket(name).get(key) ?? null;
      },
      setItem: async (key: string, value: unknown) => {
        await mocks.write(name, key, value);
        bucket(name).set(key, value);
        return value;
      },
      keys: async () => [...bucket(name).keys()],
    }),
  },
}));
vi.mock("@/api/playlist", () => ({ playlistCategories: vi.fn() }));
vi.mock("@/api/artist", () => ({ artistFilters: vi.fn(), artistPhotos: vi.fn() }));
vi.mock("@/api/video", () => ({ mvFilters: vi.fn() }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/utils/env", () => ({
  isElectron: false,
  get isMygo() {
    return mocks.mygo;
  },
  hasNativeSystemMedia: false,
}));
vi.mock("./helper", () => ({ shuffleArray: <T>(items: T[]) => [...items].reverse() }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("@/utils/format", () => ({ getSizeCover: (value: string) => value }));
vi.mock("./audioManager", () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock("./songManager", () => ({ default: {} }));
vi.mock("./lyricManager", () => ({ default: {} }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/stores", async () => ({
  ...(await import("@/stores/data")),
  ...(await import("@/stores/status")),
  ...(await import("@/stores/music")),
  ...(await import("@/stores/setting")),
}));
const song = (id: string, platform = "netease"): SongInfo => ({
  id,
  platform,
  name: id,
  subtitle: "",
  duration: 100,
  mv_id: "",
  album: "",
  links: [],
  cover: "",
});
const a = song("same");
const b = song("same", "qq");
const c = song("other");
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let data: ReturnType<typeof import("@/stores/data").useDataStore>;
let status: ReturnType<typeof import("@/stores/status").useStatusStore>;
let music: ReturnType<typeof import("@/stores/music").useMusicStore>;
let player: ReturnType<typeof import("./player").usePlayer>;
beforeEach(async () => {
  vi.resetModules();
  mocks.values.clear();
  mocks.write.mockReset().mockResolvedValue();
  mocks.read.mockReset().mockResolvedValue();
  mocks.mygo = true;
  vi.stubGlobal("localStorage", {});
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { document: { title: "" }, $message: { warning: mocks.warning } });
  setActivePinia(createPinia());
  const stores = await import("@/stores");
  data = stores.useDataStore();
  status = stores.useStatusStore();
  music = stores.useMusicStore();
  data.playList = [a, b, c];
  music.playSong = b;
  status.playIndex = 1;
  status.playSongMode = "repeat";
  player = (await import("./player")).usePlayer();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { label: "当前歌曲移到筛选列表首位", list: [b, c] },
  { label: "筛选列表只剩当前歌曲", list: [b] },
])("$label 时同步索引并复用当前音频", async ({ list }) => {
  const resume = vi.spyOn(player, "play").mockResolvedValue();
  const initialize = vi.spyOn(player, "initPlayer").mockResolvedValue();
  await player.updatePlayList(list, b, {}, { showTip: false, play: true });
  expect(data.playList).toEqual(list);
  expect(status.playIndex).toBe(0);
  expect(data.playList[status.playIndex]).toMatchObject({ id: b.id, platform: b.platform });
  expect(resume).toHaveBeenCalledOnce();
  expect(initialize).not.toHaveBeenCalled();
});

it("同曲筛选播放在随机排序后同时按id与platform定位", async () => {
  data.playList = [b, c, a];
  status.playIndex = 0;
  status.playSongMode = "shuffle";
  const resume = vi.spyOn(player, "play").mockResolvedValue();
  const initialize = vi.spyOn(player, "initPlayer").mockResolvedValue();
  await player.updatePlayList([c, b, a], b, {}, { showTip: false, play: true });
  expect(data.playList).toEqual([a, b, c]);
  expect(status.playIndex).toBe(1);
  expect(data.playList[status.playIndex]).toMatchObject({ id: b.id, platform: b.platform });
  expect(resume).toHaveBeenCalledOnce();
  expect(initialize).not.toHaveBeenCalled();
});

it("uses real stores to commit shuffle lists, mode and the platform-specific song index before persistence", async () => {
  const pending = gate<void>();
  mocks.write.mockImplementation(() => pending.promise);
  const result = player.togglePlayMode("shuffle");
  expect(status.playSongMode).toBe("shuffle");
  expect(data.playList.map((song) => song.id)).toEqual(["other", "same", "same"]);
  expect(data.originalPlayList.map((song) => song.platform)).toEqual(["netease", "qq", "netease"]);
  expect(status.playIndex).toBe(1);
  pending.resolve();
  expect(await result).toEqual({ status: "applied", mode: "shuffle" });
  expect(bucket("music-data").get("playList")).toEqual(data.playList);
});

it("reads an uncached backup without late cache writes after the native guard expires", async () => {
  status.playSongMode = "shuffle";
  bucket("music-data").set("originalPlayList", [a, b, c]);
  const pending = gate<void>();
  mocks.read.mockImplementation(() => pending.promise);
  let current = true;
  const revision = data.playbackRevision;
  const result = player.togglePlayMode("repeat", () => current);
  current = false;
  pending.resolve();
  expect(await result).toEqual({ status: "skipped" });
  expect(data.originalPlayList).toEqual([]);
  expect(data.playbackRevision).toBe(revision);
  expect(status.playSongMode).toBe("shuffle");
});

it("restores using the song current at commit time, with id and platform both required", async () => {
  status.playSongMode = "shuffle";
  data.playList = [c, a, b];
  bucket("music-data").set("originalPlayList", [b, a, c]);
  const pending = gate<void>();
  mocks.read.mockImplementation(() => pending.promise);
  const result = player.togglePlayMode("repeat");
  music.playSong = a;
  pending.resolve();
  expect(await result).toEqual({ status: "applied", mode: "repeat" });
  expect(status.playIndex).toBe(1);
  expect(data.originalPlayList).toEqual([]);
});

it("rejects a restore when a real list action changed the list and it was then put back", async () => {
  status.playSongMode = "shuffle";
  bucket("music-data").set("originalPlayList", [a, b, c]);
  const pending = gate<void>();
  mocks.read.mockImplementation(() => pending.promise);
  const original = data.playList;
  const result = player.togglePlayMode("repeat");
  await data.setPlayList([c]);
  data.playList = original;
  pending.resolve();
  expect(await result).toEqual({ status: "skipped" });
  expect(status.playSongMode).toBe("shuffle");
});

it("keeps the persistence fence until both real DB writes finish after one rejects", async () => {
  const pending = gate<void>();
  let fail = true;
  mocks.write.mockImplementation(async (_name, key) => {
    if (key === "originalPlayList" && fail) {
      fail = false;
      throw new Error("fixture quota");
    }
    if (key === "playList") await pending.promise;
  });
  const first = player.togglePlayMode("shuffle");
  let finished = false;
  void first.then(() => {
    finished = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(finished).toBe(false);
  const second = player.togglePlayMode("repeat");
  expect(await player.togglePlayMode("repeat-once")).toEqual({ status: "busy" });
  expect(status.playSongMode).toBe("shuffle");
  pending.resolve();
  expect(await first).toMatchObject({ status: "persist-failed", mode: "shuffle" });
  expect(await second).toEqual({ status: "applied", mode: "repeat" });
  expect(status.playSongMode).toBe("repeat");
  expect(mocks.warning).toHaveBeenCalledWith("message.play_mode_save_failed");
});

it("does not rewrite newer runtime state when old persistence finishes", async () => {
  const pending = gate<void>();
  mocks.write.mockImplementation(() => pending.promise);
  const result = player.togglePlayMode("shuffle");
  data.$patch({ playList: [c], originalPlayList: [], playbackRevision: Symbol() });
  status.$patch({ playSongMode: "repeat-once", playIndex: 0 });
  pending.resolve();
  await result;
  expect(data.playList).toEqual([c]);
  expect(data.originalPlayList).toEqual([]);
  expect(status.playSongMode).toBe("repeat-once");
  expect(status.playIndex).toBe(0);
});

it("retains the existing non-mygo mode path", async () => {
  mocks.mygo = false;
  expect(await player.togglePlayMode("shuffle")).toBeUndefined();
  expect(status.playSongMode).toBe("shuffle");
  await player.togglePlayMode("repeat");
  expect(data.playList).toEqual([a, b, c]);
  expect(status.playIndex).toBe(1);
});

it.each(["list", "mode"] as const)(
  "rejects a queued tray request after an external %s change while UI persistence is active",
  async (change) => {
    const pending = gate<void>();
    let writes = 0;
    mocks.write.mockImplementation(() => (++writes <= 2 ? pending.promise : Promise.resolve()));
    const { createShellTraySession } = await import("@/composables/shellTray");
    const syncPlayback = vi.fn<(state: TrayPlaybackState) => Promise<void>>(async () => {});
    const scope = effectScope();
    const tray = scope.run(() => createShellTraySession({ syncPlayback }));
    if (!tray) throw new Error("No tray session");
    try {
      await tray.start(11);
      const toggle = vi.spyOn(player, "togglePlayMode");
      const commits = vi.spyOn(data, "$patch");
      const active = player.togglePlayMode("repeat-once");
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const state = syncPlayback.mock.calls.at(-1)?.[0];
      if (!state) throw new Error("No acknowledged tray snapshot");
      tray.handle({
        epoch: state.epoch,
        revision: state.revision,
        trackKey: state.trackKey,
        action: "set-play-mode",
        mode: "shuffle",
      });
      expect(toggle).toHaveBeenCalledTimes(2);
      const queued = toggle.mock.results[1];
      if (queued.type !== "return") throw new Error("No queued result");
      if (change === "list") await data.setPlayList([c, b]);
      else {
        status.playSongMode = "shuffle";
        status.playSongMode = "repeat-once";
      }
      const external = data.playList;
      const committed = commits.mock.calls.length;
      const saved = mocks.write.mock.calls.length;
      pending.resolve();
      await active;
      expect(await queued.value).toEqual({ status: "skipped" });
      expect(data.playList).toBe(external);
      expect(status.playSongMode).toBe("repeat-once");
      expect(commits).toHaveBeenCalledTimes(committed);
      expect(mocks.write).toHaveBeenCalledTimes(saved);
    } finally {
      tray.dispose();
      scope.stop();
      pending.resolve();
    }
  },
);
