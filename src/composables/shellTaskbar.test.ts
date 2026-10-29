import { reactive } from "vue";
import { describe, expect, it, vi } from "vitest";
import { TaskbarSession, type TaskbarCommand, type TaskbarState } from "@/platform/taskbarSession";

vi.mock("@/stores", () => ({}));
vi.mock("@/utils/player", () => ({}));
vi.mock("@/platform/filesSession", () => ({}));
vi.mock("@/platform/localFilesSession", () => ({}));
vi.mock("@/platform/desktopLyricsSession", () => ({}));
import { createTaskbarShellConsumer } from "./shellTaskbar";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
describe("shellTaskbar clock consumer", () => {
  it("suppresses subsecond clock sends but updates song, pause, labels and settings", async () => {
    const state = reactive({
      track: "a",
      enabled: true,
      playing: true,
      position: 0,
      duration: 10000,
      play: "Play",
    });
    const provider = {
      begin: vi.fn(async () => 1),
      sync: vi.fn<(state: TaskbarState) => Promise<void>>(async () => {}),
      teardown: vi.fn<(epoch: number) => Promise<void>>(async () => {}),
      onCommand: (cb: (command: TaskbarCommand) => void) => {
        void cb;
        return () => {};
      },
    };
    const session = new TaskbarSession(provider, vi.fn(), vi.fn());
    const shell = createTaskbarShellConsumer(session, {
      track: () => state.track,
      enabled: () => state.enabled,
      playing: () => state.playing,
      positionMs: () => state.position,
      durationMs: () => state.duration,
      labels: () => ({ previous: "Previous", play: state.play, pause: "Pause", next: "Next" }),
    });
    await shell.start();
    await flush();
    for (let i = 1; i < 1000; i += 16) {
      state.position = i;
      await flush();
    }
    expect(provider.sync).toHaveBeenCalledTimes(1);
    state.position = 1000;
    await flush();
    expect(provider.sync).toHaveBeenCalledTimes(2);
    state.playing = false;
    await flush();
    state.track = "b";
    await flush();
    state.play = "播放";
    await flush();
    state.enabled = false;
    await flush();
    expect(provider.sync).toHaveBeenCalledTimes(6);
    expect(provider.sync.mock.calls[5]?.[0].enabled).toBe(false);
    await shell.dispose();
    state.position = 3000;
    state.enabled = true;
    await flush();
    expect(provider.sync).toHaveBeenCalledTimes(6);
    expect(provider.teardown).toHaveBeenCalledExactlyOnceWith(1);
  });
});
