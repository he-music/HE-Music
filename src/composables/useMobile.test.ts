import { describe, expect, it, vi } from "vitest";
import { computed } from "vue";

const { viewport, runtime } = await vi.hoisted(async () => {
  const { ref } = await import("vue");
  const runtime: { kind: "web" | "mygo" } = { kind: "web" };
  return { viewport: ref(1280), runtime };
});

vi.mock("@/platform", () => ({ platform: runtime }));
vi.mock("@vueuse/core", () => ({
  useBreakpoints: (points: Record<string, number>) => ({
    smaller: (key: string) => computed(() => viewport.value < points[key]),
    greaterOrEqual: (key: string) => computed(() => viewport.value >= points[key]),
  }),
}));

import { useMobile } from "./useMobile";

const widths = [390, 640, 768, 800, 810, 900, 960, 989, 990, 1000, 1024, 1199, 1200, 1280];

describe("播放器与导航的布局策略", () => {
  it("mygo 在缩放窗口时始终保留桌面交互", () => {
    runtime.kind = "mygo";
    const layout = useMobile();
    for (const width of widths) {
      viewport.value = width;
      expect(layout.isDesktopLayout.value, `${width}px 导航`).toBe(true);
      expect(layout.isMobilePlayer.value, `${width}px 全屏播放器`).toBe(false);
      expect(layout.isMobilePlayBar.value, `${width}px 播放条`).toBe(false);
      expect(layout.isDesktop.value, `${width}px 原始宽度`).toBe(width >= 1024);
    }
  });

  it("网页端继续按可用宽度切换播放器和导航，放大后恢复", () => {
    runtime.kind = "web";
    const layout = useMobile();
    for (const width of [...widths, ...[...widths].reverse()]) {
      viewport.value = width;
      expect(layout.isDesktopLayout.value, `${width}px 导航`).toBe(width >= 1024);
      expect(layout.isMobilePlayer.value, `${width}px 全屏播放器`).toBe(width < 990);
      expect(layout.isMobilePlayBar.value, `${width}px 播放条`).toBe(width < 810);
    }
  });
});
