import { describe, expect, it } from "vitest";
import { fitPVProfile, resolvePVSafeArea } from "./viewport";

// 安全排版只改变歌词构图，不改原版预设或背景画布尺寸。
describe("PV full viewport layout", () => {
  it("keeps the exact original profile in the half-width layout", () => {
    const profile = { region: { cx: 0.5, cy: 0.5, w: 0.8, h: 0.6 }, text: { heroSize: 0.1 } };
    expect(fitPVProfile(profile, {})).toBe(profile);
  });
  it("maps Hanabi lyrics into the space between metadata and controls", () => {
    const profile = {
      region: { cx: 0.5, cy: 0.5, w: 0.8, h: 0.6 },
      text: { heroSize: 0.1, layout: "center" },
    };
    const next = fitPVProfile(profile, { lyricSafeArea: { top: 0.25, bottom: 0.15 } });
    expect(next.region.cy).toBeCloseTo(0.55);
    expect(next.region.h).toBeCloseTo(0.36);
    expect(next.region.w).toBe(profile.region.w);
    expect(next.text.heroSize).toBeCloseTo(0.06);
    expect(next.text.layout).toBe("center");
    expect(profile.region.cy).toBe(0.5);
    expect(profile.text.heroSize).toBe(0.1);
  });
  it("scales Lumiere text independently of its lighting and camera", () => {
    const light = () => "full viewport";
    const profile = {
      region: { cx: 0.5, cy: 0.5, w: 0.8, h: 0.8 },
      heroSize: 0.12,
      light,
      camera: { push: 0.1 },
    };
    const next = fitPVProfile(profile, { lyricSafeArea: { top: 0.25, bottom: 0.15 } });
    expect(next.heroSize).toBeCloseTo(0.072);
    expect(next.light).toBe(light);
    expect(next.camera).toBe(profile.camera);
    expect(next.region.cy - next.region.h / 2).toBeGreaterThanOrEqual(0.25);
    expect(next.region.cy + next.region.h / 2).toBeLessThanOrEqual(0.85);
  });
  it("handles unknown dimensions and constrains short windows to a usable lyric area", () => {
    expect(resolvePVSafeArea(0, 180, 100)).toBeUndefined();
    expect(resolvePVSafeArea(800, 200, 120)).toEqual({ top: 0.25, bottom: 0.15 });
    expect(resolvePVSafeArea(300, 240, 200)).toEqual({ top: 0.5, bottom: 0.25 });
  });
});
