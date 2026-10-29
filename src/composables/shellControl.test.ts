import { reactive } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ControlCommand, ControlProvider } from "@/platform/controlSession";
const mocks = vi.hoisted(() => ({
  play: vi.fn(async () => {}),
  cancelPendingAutoplay: vi.fn(),
  pause: vi.fn(async () => {}),
  playOrPause: vi.fn(async () => {}),
  nextOrPrev: vi.fn(async (_direction: "next" | "prev") => {
    void _direction;
  }),
  music: { playSong: { id: 1, platform: "netease", path: "" } },
}));
vi.mock("@/stores", () => ({ useMusicStore: () => reactive(mocks.music) }));
vi.mock("@/utils/player", () => ({ usePlayer: () => mocks }));
import { controlPort, createShellControlSession } from "./shellControl";
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("shellControl player consumer", () => {
  it("uses existing player actions for all five routes without starting native IO", async () => {
    let emit: (command: ControlCommand) => void = () => {};
    const provider: ControlProvider = {
      start: vi.fn(async () => ({ generation: 1, port: 25666 })),
      receipt: vi.fn(async () => {}),
      teardown: vi.fn(async () => {}),
      onCommand: (listener) => {
        emit = listener;
        return () => {};
      },
    };
    const shell = createShellControlSession(provider);
    await shell?.start();
    ["play", "pause", "toggle", "next", "prev"].forEach((action, index) => {
      emit({ generation: 1, requestId: index + 1, action });
    });
    await flush();
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.playOrPause).toHaveBeenCalledOnce();
    expect(mocks.nextOrPrev.mock.calls.map(([direction]) => direction)).toEqual(["next", "prev"]);
    emit({ generation: 1, requestId: 6, action: "play" });
    reactive(mocks.music).playSong.id = 2;
    reactive(mocks.music).playSong.id = 1;
    await flush();
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(provider.receipt).toHaveBeenLastCalledWith(1, 6, false);
    await shell?.dispose();
    emit({ generation: 1, requestId: 7, action: "play" });
    await flush();
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(provider.teardown).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps web/Electron optional and validates renderer port configuration", () => {
    expect(createShellControlSession(undefined)).toBeUndefined();
    expect(controlPort(undefined)).toBe(0);
    expect(controlPort("")).toBe(0);
    expect(controlPort("25667")).toBe(25667);
    for (const invalid of ["0", "65536", "1.5", "-1", "localhost:25666", "1e4", " 25666", 25666])
      expect(() => controlPort(invalid)).toThrow("Invalid control port");
  });
});
