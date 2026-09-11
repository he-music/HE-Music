import { afterEach, describe, expect, it, vi } from "vitest";

// src/utils/songManager.test.ts — 封面异步请求竞态、失败回退和缓存隔离。
const { status, extract } = vi.hoisted(() => ({
  status: { songCoverTheme: {} as any },
  extract: vi.fn(),
}));
vi.mock("@/stores", () => ({
  useStatusStore: () => status,
  useDataStore: vi.fn(),
  useMusicStore: vi.fn(),
}));
vi.mock("@/api/song", () => ({ songUrl: vi.fn() }));
vi.mock("./color", () => ({
  getCoverColorData: extract,
  MONOTONOUS_THEME: { main: { r: 239, g: 239, b: 239 } },
}));
import songManager from "./songManager";

class MockImage {
  static pending: MockImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin = "";
  src = "";
  remove() {}
  constructor() {
    MockImage.pending.push(this);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  MockImage.pending = [];
});
describe("cover theme loading", () => {
  it("does not let a slow previous cover overwrite the current song", async () => {
    vi.stubGlobal("Image", MockImage);
    const first = songManager.getCoverColor("first-cover");
    const second = songManager.getCoverColor("second-cover");
    extract.mockReturnValueOnce({ main: { r: 10, g: 20, b: 30 } });
    MockImage.pending[1].onload?.();
    await second;
    extract.mockReturnValueOnce({ main: { r: 200, g: 100, b: 50 } });
    MockImage.pending[0].onload?.();
    await first;
    expect(status.songCoverTheme.main).toEqual({ r: 10, g: 20, b: 30 });
    status.songCoverTheme.main.r = 99;
    await songManager.getCoverColor("second-cover");
    expect(status.songCoverTheme.main.r).toBe(10);
    expect(MockImage.pending).toHaveLength(2);
  });
  it("falls back for image errors and canvas access errors", async () => {
    vi.stubGlobal("Image", MockImage);
    const failed = songManager.getCoverColor("failed-cover");
    MockImage.pending[0].onerror?.();
    await failed;
    expect(status.songCoverTheme.main.r).toBe(239);
    const tainted = songManager.getCoverColor("tainted-cover");
    extract.mockImplementationOnce(() => {
      throw new Error("tainted canvas");
    });
    MockImage.pending[1].onload?.();
    await tainted;
    expect(status.songCoverTheme.main.r).toBe(239);
  });
});
