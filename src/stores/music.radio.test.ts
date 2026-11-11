import { createApp, nextTick } from "vue";
import { createPinia, disposePinia } from "pinia";
import persistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SongInfo } from "@/types/main.hemusic";
import { useMusicStore } from "./music";
import { useStatusStore } from "./status";
import { useSettingStore } from "./setting";
import { persistStatus } from "./persistStatus";
import songManager from "@/utils/songManager";

vi.mock("@/utils/format", () => ({ getSizeCover: (song: SongInfo) => song.cover }));
vi.mock("@/utils/blob", () => ({ default: { revokeBlobURL: vi.fn() } }));
vi.mock("@/utils/helper", () => ({ shuffleArray: <T>(values: T[]) => values }));
vi.mock("@/api/artist", () => ({ artistPhotos: vi.fn() }));
vi.mock("@/api/song", () => ({ songUrl: vi.fn() }));
vi.mock("@/utils/color", () => ({ getCoverColorData: vi.fn(), MONOTONOUS_THEME: {} }));
vi.mock("@/platform/gateway", () => ({ gatewayProxyUrl: (url: string) => url }));
vi.mock("@/stores", async () => {
  const { useMusicStore } = await import("./music");
  const { useStatusStore } = await import("./status");
  return { useMusicStore, useStatusStore, useDataStore: () => ({ playList: [] }) };
});

const disposers: (() => void)[] = [];
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function boot() {
  const pinia = createPinia().use(persistedstate).use(persistStatus);
  createApp({}).use(pinia);
  const music = useMusicStore(pinia);
  const status = useStatusStore(pinia);
  const setting = useSettingStore(pinia);
  disposers.push(() => disposePinia(pinia));
  return { pinia, music, status, setting };
}

function song(id: string): SongInfo {
  return {
    id,
    platform: "test",
    name: id,
    artists: "测试歌手",
    album: "测试专辑",
    cover: "https://fixture.invalid/cover.jpg",
    duration: 180000,
    mv_id: "",
    subtitle: "",
    links: [],
  };
}

it.each([true, false])("重启后恢复电台歌曲和分页状态（记忆进度：%s）", async (memoryLastSeek) => {
  const first = boot();
  first.setting.memoryLastSeek = memoryLastSeek;
  const list = [song("radio-song-1"), song("radio-song-2"), song("radio-song-3")];
  first.music.radio = {
    id: "radio-id",
    platform: "test",
    name: "测试电台",
    list,
    playIndex: 1,
    pageIndex: 3,
  };
  first.music.playSong = list[1];
  first.status.radioMode = true;
  first.status.currentTime = 42000;
  await nextTick();
  disposePinia(first.pinia);

  const restored = boot();
  expect(restored.status.radioMode).toBe(true);
  expect(restored.music.radio).toEqual({
    id: "radio-id",
    platform: "test",
    name: "测试电台",
    list,
    playIndex: 1,
    pageIndex: 3,
  });
  expect(songManager.getPlaySongData()).toEqual(list[1]);
  expect(restored.status.currentTime).toBe(memoryLastSeek ? 42000 : 0);

  // 电台下一首仍从保存的列表位置继续，并保存新的位置。
  restored.music.radio.playIndex++;
  expect(songManager.getPlaySongData()).toEqual(list[2]);
  await nextTick();
  disposePinia(restored.pinia);
  const nextBoot = boot();
  expect(nextBoot.music.radio.pageIndex).toBe(3);
  expect(songManager.getPlaySongData()).toEqual(list[2]);
});
