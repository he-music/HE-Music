import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: { playStatus: false, eqEnabled: false, playVolume: 0.7, playRate: 1 },
  setting: { smtcOpen: false, getFadeTime: 0 },
}));
vi.mock("@/stores", () => ({
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.setting,
  useMusicStore: () => ({ playSong: { id: "track", platform: "netease" } }),
  useDataStore: () => ({}),
}));
vi.mock("@/utils/env", () => ({ isElectron: false, isMygo: true, hasNativeSystemMedia: true }));
vi.mock("./helper", () => ({ shuffleArray: (items: unknown[]) => items }));
vi.mock("./blob", () => ({ default: {} }));
vi.mock("./songManager", () => ({ default: {} }));
vi.mock("./lyricManager", () => ({ default: {} }));
vi.mock("@/api/radio", () => ({ listRadioSongs: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
class Media extends EventTarget {
  src = "";
  crossOrigin: string | null = null;
  volume = 1;
  defaultPlaybackRate = 1;
  playbackRate = 1;
  currentTime = 0;
  duration = 180;
  paused = true;
  load() {}
  removeAttribute() {
    this.src = "";
  }
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause() {
    this.paused = true;
  }
}
const elements: Media[] = [];
let manager: typeof import("./audioManager").default;
let player: ReturnType<typeof import("./player").usePlayer>;
let resolveProbe: (value: { ok: boolean }) => void;
beforeEach(async () => {
  vi.resetModules();
  mocks.status.playStatus = false;
  vi.stubGlobal("window", { document: { title: "" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    ),
  );
  vi.stubGlobal("Audio", function () {
    const media = new Media();
    elements.push(media);
    return media;
  });
  manager = (await import("./audioManager")).default;
  player = (await import("./player")).usePlayer();
});
afterEach(() => {
  manager.clearSource();
  elements.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("a real Player pause during the Manager probe cancels autoplay and keeps the preload available", async () => {
  const loading = manager.play("https://synthetic.invalid/song.mp3");
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(manager.src).toBe("");
  await player.pause();
  resolveProbe({ ok: false });
  await loading;
  expect(manager.src).toBe("https://synthetic.invalid/song.mp3");
  expect(elements.every((element) => element.paused)).toBe(true);
  expect(elements.every((element) => element.play.mock.calls.length === 0)).toBe(true);
});
