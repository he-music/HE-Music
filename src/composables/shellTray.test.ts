import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, reactive, ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import type { PlayModeType } from "@/types/main";
import type { TrayPlaybackState, TrayRequest } from "@/platform/mygo.bindings";

let data: {
  userLoginStatus: boolean;
  userData: { id: string };
  playbackRevision: symbol;
  likes: string[];
  isLikeSong: (song: SongInfo) => boolean;
};
let music: { playSong: SongInfo };
let status: {
  playStatus: boolean;
  playSongMode: PlayModeType;
  radioMode: boolean;
  currentTime: number;
  lyricClock: number;
};
const available = ref(true);
const player = {
  playOrPause: vi.fn(async () => {}),
  nextOrPrev: vi.fn(async () => {}),
  togglePlayMode:
    vi.fn<(mode: PlayModeType | false, guard?: () => boolean) => Promise<undefined>>(),
};
vi.mock("@/stores", () => ({
  useDataStore: () => data,
  useMusicStore: () => music,
  useStatusStore: () => status,
}));
vi.mock("@/utils/player", () => ({ usePlayer: () => player }));
vi.mock("@/platform/localFilesSession", () => ({
  nativeLocalEntry: () => (available.value ? {} : undefined),
}));
import { createShellTraySession } from "./shellTray";
const song = (id: string): SongInfo => ({
  id,
  platform: "fixture",
  name: id,
  subtitle: "",
  cover: "",
  album: "",
  links: [],
  duration: 100,
  mv_id: "",
});
const key = (song: SongInfo) => JSON.stringify([song.platform, song.id]);
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  data = reactive({
    userLoginStatus: true,
    userData: { id: "account" },
    playbackRevision: Symbol(),
    likes: [],
    isLikeSong: (song: SongInfo) => data.likes.includes(key(song)),
  });
  music = reactive({ playSong: song("A") });
  status = reactive({
    playStatus: true,
    playSongMode: "repeat",
    radioMode: false,
    currentTime: 0,
    lyricClock: 0,
  });
  available.value = true;
  player.togglePlayMode.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.resetAllMocks();
});
function fixture(options: Parameters<typeof createShellTraySession>[1] = {}) {
  const syncPlayback = vi.fn<(state: TrayPlaybackState) => Promise<void>>(async () => {});
  const favorite = vi.fn<(song: SongInfo, desired: boolean) => Promise<void>>(async () => {});
  const settings = vi.fn();
  const report = vi.fn();
  const scope = effectScope();
  const session = scope.run(() =>
    createShellTraySession(
      { syncPlayback },
      {
        loadFavorite: async () => favorite,
        loadSettings: async () => settings,
        reportFailure: report,
        ...options,
      },
    ),
  );
  if (!session) throw new Error("No tray session");
  const stop = () => {
    session.dispose();
    scope.stop();
  };
  cleanups.push(stop);
  const last = () => {
    const value = syncPlayback.mock.calls.at(-1)?.[0];
    if (!value) throw new Error("No tray snapshot");
    return value;
  };
  const request = (
    action: TrayRequest["action"],
    fields: Partial<TrayRequest> = {},
  ): TrayRequest => {
    const state = last();
    return {
      epoch: state.epoch,
      revision: state.revision,
      trackKey: state.trackKey,
      action,
      ...fields,
    };
  };
  return { session, stop, syncPlayback, last, request, favorite, settings, report };
}

it("publishes only necessary low-frequency state and releases watchers on disposal", async () => {
  const f = fixture();
  await f.session.start(7);
  for (let i = 0; i < 50; i++) {
    status.currentTime++;
    status.lyricClock++;
  }
  data.likes.push(key(song("B")));
  await flush();
  expect(f.syncPlayback).toHaveBeenCalledOnce();
  data.likes.push(key(music.playSong));
  await flush();
  expect(f.last().liked).toBe(true);
  expect(f.syncPlayback).toHaveBeenCalledTimes(2);
  f.stop();
  status.playStatus = false;
  data.userLoginStatus = false;
  await flush();
  expect(f.syncPlayback).toHaveBeenCalledTimes(2);
});

it("allows modes without login and for registered local songs, but denies local favorites and radio modes", async () => {
  const f = fixture();
  await f.session.start(7);
  data.userLoginStatus = false;
  await flush();
  expect(f.last()).toMatchObject({ canFavorite: false, canSetMode: true });
  music.playSong.path = "relative/song.mp3";
  await flush();
  expect(f.last()).toMatchObject({ hasSong: true, canFavorite: false, canSetMode: true });
  status.radioMode = true;
  await flush();
  expect(f.last().canSetMode).toBe(false);
  available.value = false;
  await flush();
  expect(f.last()).toMatchObject({
    trackKey: "",
    hasSong: false,
    playing: false,
    liked: false,
    canFavorite: false,
    canSetMode: false,
  });
});

it("does not import or favorite an old occurrence after A→B→A during loading", async () => {
  const pending = gate<(song: SongInfo, desired: boolean) => Promise<void>>();
  const favorite = vi.fn<(song: SongInfo, desired: boolean) => Promise<void>>(async () => {});
  const f = fixture({ loadFavorite: () => pending.promise });
  await f.session.start(7);
  f.session.handle(f.request("set-favorite", { favorite: true }));
  music.playSong = song("B");
  music.playSong = song("A");
  pending.resolve(favorite);
  await flush();
  expect(favorite).not.toHaveBeenCalled();
  f.session.handle(f.request("set-favorite", { favorite: true }));
  await flush();
  expect(favorite).toHaveBeenCalledOnce();
});

it("captures the original song and desired favorite, never optimistically changes current B", async () => {
  const pending = gate<void>();
  const favorite = vi.fn<(song: SongInfo, desired: boolean) => Promise<void>>(
    async () => pending.promise,
  );
  const f = fixture({ loadFavorite: async () => favorite });
  await f.session.start(7);
  const intent = f.request("set-favorite", { favorite: true });
  f.session.handle(intent);
  intent.favorite = false;
  await flush();
  expect(favorite).toHaveBeenCalledWith(song("A"), true);
  expect(f.last()).toMatchObject({ canFavorite: false, liked: false });
  music.playSong = song("B");
  pending.resolve();
  await flush();
  expect(f.last()).toMatchObject({ trackKey: key(song("B")), liked: false, canFavorite: true });
  expect(favorite).toHaveBeenCalledOnce();
});

it("passes explicit modes and an occurrence guard, and ignores stale or duplicate menu requests", async () => {
  const pending = gate<undefined>();
  player.togglePlayMode.mockImplementation(() => pending.promise);
  const f = fixture();
  await f.session.start(9);
  const old = f.request("set-play-mode", { mode: "shuffle" });
  f.session.handle(old);
  f.session.handle(old);
  expect(player.togglePlayMode).toHaveBeenCalledOnce();
  const [mode, guard] = player.togglePlayMode.mock.calls[0];
  expect(mode).toBe("shuffle");
  expect(guard?.()).toBe(true);
  music.playSong = song("B");
  music.playSong = song("A");
  expect(guard?.()).toBe(false);
  pending.resolve(undefined);
  await flush();
  f.session.handle(old);
  expect(player.togglePlayMode).toHaveBeenCalledOnce();
});

it("never routes unknown actions to next and cancels delayed settings or favorites on dispose", async () => {
  const pending = gate<() => void>();
  const open = vi.fn();
  const f = fixture({ loadSettings: () => pending.promise });
  await f.session.start(1);
  const unknown = f.request("next");
  Reflect.set(unknown, "action", "unknown");
  f.session.handle(unknown);
  expect(player.nextOrPrev).not.toHaveBeenCalled();
  f.session.handle(f.request("open-settings"));
  f.stop();
  pending.resolve(open);
  await flush();
  expect(open).not.toHaveBeenCalled();
});
