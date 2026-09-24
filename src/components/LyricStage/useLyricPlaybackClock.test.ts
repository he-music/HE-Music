import { effectScope, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLyricPlaybackClock } from "./useLyricPlaybackClock";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const playing = ref(true),
    visible = ref(true),
    identity = ref("song-a"),
    offset = ref(0);
  let audioTime = 1000;
  let seek: (() => void) | undefined;
  const unsubscribe = vi.fn(() => {
    seek = undefined;
  });
  const scope = effectScope();
  const time = scope.run(() =>
    useLyricPlaybackClock({
      playing: () => playing.value,
      visible: () => visible.value,
      identity: () => identity.value,
      offset: () => offset.value,
      readTime: () => audioTime,
      subscribeSeek: (fn) => {
        seek = fn;
        return unsubscribe;
      },
    }),
  )!;
  const tick = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(0));
  };
  return {
    playing,
    visible,
    identity,
    offset,
    time,
    scope,
    frames,
    unsubscribe,
    tick,
    setAudio: (time: number) => {
      audioTime = time;
    },
    seek: () => seek?.(),
  };
}

describe("lyric playback clock", () => {
  it("freezes immediately while audio continues its fade-out", () => {
    const f = fixture();
    try {
      f.setAudio(1200);
      f.tick();
      expect(f.time.value).toBe(1200);
      f.setAudio(1210);
      f.playing.value = false;
      expect(f.time.value).toBe(1210);
      expect(f.frames.size).toBe(0);
      for (const audio of [1250, 1500, 1750, 2000]) {
        f.setAudio(audio);
        f.tick();
        expect(f.time.value).toBe(1210);
      }
      f.visible.value = false;
      f.visible.value = true;
      expect(f.time.value).toBe(1210);
      expect(f.frames.size).toBe(0);
      f.playing.value = true;
      expect(f.time.value).toBe(2000);
      expect(f.frames.size).toBe(1);
    } finally {
      f.scope.stop();
    }
  });
  it("allows explicit seeks, lyric offsets and song replacement while paused", () => {
    const f = fixture();
    try {
      f.playing.value = false;
      f.setAudio(2000);
      f.offset.value = 500;
      expect(f.time.value).toBe(1500);
      f.setAudio(7000);
      f.seek();
      expect(f.time.value).toBe(7500);
      f.setAudio(0);
      f.identity.value = "song-b";
      expect(f.time.value).toBe(500);
    } finally {
      f.scope.stop();
    }
  });
  it("stops in a hidden document and cleans up both RAF and seek subscription", () => {
    const f = fixture();
    f.visible.value = false;
    expect(f.frames.size).toBe(0);
    f.setAudio(5000);
    f.visible.value = true;
    expect(f.time.value).toBe(5000);
    expect(f.frames.size).toBe(1);
    f.scope.stop();
    expect(f.frames.size).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.setAudio(6000);
    f.seek();
    expect(f.time.value).toBe(5000);
  });
});
