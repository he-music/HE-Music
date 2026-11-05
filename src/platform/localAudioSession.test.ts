import { afterEach, describe, expect, it, vi } from "vitest";
import { blockLocalAudio, localAudioBlocked, registerLocalAudioStopper } from "./localAudioSession";

afterEach(() => registerLocalAudioStopper(() => {}));

describe("local audio write gate", () => {
  it("stops local playback and releases only its own write gate", () => {
    const stop = vi.fn();
    registerLocalAudioStopper(stop);
    const first = blockLocalAudio();
    const second = blockLocalAudio();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(localAudioBlocked()).toBe(true);
    first();
    first();
    expect(localAudioBlocked()).toBe(true);
    second();
    expect(localAudioBlocked()).toBe(false);
  });

  it("releases the write gate if stopping playback fails", () => {
    registerLocalAudioStopper(() => {
      throw new Error("stop failed");
    });
    expect(blockLocalAudio).toThrow("stop failed");
    expect(localAudioBlocked()).toBe(false);
  });
});
