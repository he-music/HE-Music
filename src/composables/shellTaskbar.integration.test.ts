import { describe, expect, it, vi } from "vitest";
import type { TaskbarCommand, TaskbarState } from "@/platform/taskbarSession";

const mocks = vi.hoisted(() => ({
  music: { playSong: { id: "remote", path: "", platform: "netease" } },
  status: { playStatus: true, currentTime: 0, duration: 10000 },
  setting: { showTaskbarProgress: true },
  player: {
    playOrPause: vi.fn(async () => {}),
    nextOrPrev: vi.fn(async () => {}),
    setVolume: vi.fn(),
  },
}));
vi.mock("@/stores", () => ({
  useMusicStore: () => mocks.music,
  useStatusStore: () => mocks.status,
  useSettingStore: () => mocks.setting,
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks.player }));
vi.mock("@/platform/filesSession", () => ({ filesSession: { value: undefined } }));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: () => undefined }));
vi.mock("@/platform/desktopLyricsSession", () => ({ desktopLyricsSession: { value: undefined } }));
import { createShellTaskbarSession } from "./shellTaskbar";

it("routes only safe playback commands and retains local grant and owner checks", async () => {
  let emit: ((command: TaskbarCommand) => void) | undefined;
  let state: TaskbarState | undefined;
  const provider = {
    begin: async () => 1,
    sync: async (next: TaskbarState) => {
      state = next;
    },
    teardown: vi.fn(async () => {}),
    onCommand: (listener: (command: TaskbarCommand) => void) => {
      emit = listener;
      return () => {};
    },
  };
  const shell = createShellTaskbarSession(provider);
  await shell?.start();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const click = (action: TaskbarCommand["action"]) => {
    if (state) emit?.({ epoch: state.epoch, seq: state.seq, action });
  };
  click("previous");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(mocks.player.nextOrPrev).toHaveBeenCalledWith("prev");
  mocks.music.playSong = { id: "mygo-local:ungranted", path: "song.flac", platform: "local" };
  click("toggle");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(mocks.player.playOrPause).not.toHaveBeenCalled();
  mocks.music.playSong = { id: "remote", path: "", platform: "netease" };
  click("next");
  await shell?.dispose();
  expect(mocks.player.nextOrPrev).toHaveBeenCalledTimes(1);
  expect(provider.teardown).toHaveBeenCalledTimes(1);
});

describe("optional capability", () => {
  it("does not create a session without a provider", () => {
    expect(createShellTaskbarSession(undefined)).toBeUndefined();
  });
});
