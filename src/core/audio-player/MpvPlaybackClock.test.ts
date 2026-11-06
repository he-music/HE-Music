import { describe, expect, it } from "vitest";
import { MpvPlaybackClock } from "./MpvPlaybackClock";

describe("MpvPlaybackClock", () => {
  it("推算倍速、缓冲、暂停、seek，并限制在时长内", () => {
    let now = 50_000;
    const clock = new MpvPlaybackClock(() => now);
    clock.update({ position: 3, duration: 20, rate: 2, state: "playing" });
    now += 1500;
    expect(clock.currentTime).toBe(6);
    clock.update({ position: 5, duration: 20, rate: 2, state: "buffering" });
    now += 2000;
    expect(clock.currentTime).toBe(5);
    clock.update({ position: 10, duration: 20, rate: 0.5, state: "paused" });
    now += 2000;
    expect(clock.currentTime).toBe(10);
    clock.update({ position: 18, duration: 20, rate: 2, state: "playing" });
    now += 2000;
    expect(clock.currentTime).toBe(20);
  });
  it("未知时长仍推算，切歌重建时钟", () => {
    let now = 0;
    const clock = new MpvPlaybackClock(() => now);
    clock.update({ position: 1, duration: 0, rate: 1, state: "playing" });
    now += 2000;
    expect(clock.currentTime).toBe(3);
    clock.update({ position: 0, duration: 8, rate: 1, state: "idle" });
    now += 2000;
    expect(clock.currentTime).toBe(0);
  });
});
