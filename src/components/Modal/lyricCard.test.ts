import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLyricCardPng,
  downloadLyricCardPng,
  lyricCardFilename,
  LyricCardTooLargeError,
} from "./lyricCard";

const content = {
  title: "歌名",
  artist: "歌手甲 / 歌手乙",
  lyrics: [["歌词", "Translation"], ["第二行"]],
};
const withCover = { ...content, coverUrl: "https://example.test/cover" };
const signal = () => new AbortController().signal;

function mockCanvas() {
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn<(text: string, x: number, y: number) => void>(),
    getImageData: vi.fn(),
    measureText: (text: string) => ({ width: Array.from(text).length * 30 }),
  };
  return {
    ctx,
    canvas: {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: vi.fn((complete: (blob: Blob | null) => void) => {
        complete(new Blob(["mock PNG"], { type: "image/png" }));
      }),
    },
  };
}

function mockDocument(...canvases: ReturnType<typeof mockCanvas>["canvas"][]) {
  const createElement = vi.fn(() => canvases.shift());
  vi.stubGlobal("document", { createElement });
  return { createElement };
}

function mockImage(result: "loaded" | "failed" | "pending") {
  const modeOnLoad = vi.fn();
  const removeAttribute = vi.fn();
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 300;
      naturalHeight = 150;
      crossOrigin?: string;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      removeAttribute = removeAttribute;
      set src(url: string) {
        modeOnLoad(this.crossOrigin, url);
        if (result === "loaded") this.onload?.();
        if (result === "failed") this.onerror?.();
      }
    },
  );
  return { modeOnLoad, removeAttribute };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createLyricCardPng", () => {
  it("encodes the title, artist, ordered lyrics and variants as PNG without a cover", async () => {
    const { canvas, ctx } = mockCanvas();
    mockDocument(canvas);
    const blob = await createLyricCardPng(content, signal());
    expect(blob.type).toBe("image/png");
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText.mock.calls.map(([text]) => text)).toEqual([
      "歌名",
      "歌手甲 / 歌手乙",
      "歌词",
      "Translation",
      "第二行",
    ]);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
  });

  it("wraps CJK, long words, and emoji clusters without dropping text", async () => {
    const { canvas, ctx } = mockCanvas();
    mockDocument(canvas);
    const family = "👩‍👩‍👦";
    const chinese = "音乐歌词".repeat(20);
    const lyric = `${chinese}${family.repeat(16)}${"a".repeat(100)}`;
    await createLyricCardPng({ ...content, lyrics: [[lyric, "第一段\n第二段"]] }, signal());
    const rows = ctx.fillText.mock.calls.map(([text]) => text);
    const lyricRows = rows.slice(2, -2);
    expect(lyricRows.length).toBeGreaterThan(2);
    expect(lyricRows.join("")).toBe(lyric);
    expect(lyricRows.join("\n").match(new RegExp(family, "gu"))).toHaveLength(16);
    expect(rows.slice(-2)).toEqual(["第一段", "第二段"]);
  });

  it("rejects oversized text before loading a cover or allocating a canvas", async () => {
    const doc = mockDocument();
    const image = mockImage("pending");
    await expect(
      createLyricCardPng({ ...withCover, lyrics: [["唱".repeat(12_001)]] }, signal()),
    ).rejects.toBeInstanceOf(LyricCardTooLargeError);
    expect(doc.createElement).not.toHaveBeenCalled();
    expect(image.modeOnLoad).not.toHaveBeenCalled();
  });

  it("rejects content whose laid-out rows exceed the pixel budget instead of cropping", async () => {
    const { canvas } = mockCanvas();
    mockDocument(canvas);
    await expect(
      createLyricCardPng(
        { ...content, lyrics: Array.from({ length: 100 }, () => ["唱"]) },
        signal(),
      ),
    ).rejects.toBeInstanceOf(LyricCardTooLargeError);
    expect(canvas.height).toBe(0);
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });

  it("requests artwork anonymously and draws only the verified cover canvas", async () => {
    const covers = mockCanvas();
    const card = mockCanvas();
    const { modeOnLoad } = mockImage("loaded");
    mockDocument(covers.canvas, card.canvas);
    await createLyricCardPng(withCover, signal());
    expect(modeOnLoad).toHaveBeenCalledWith("anonymous", withCover.coverUrl);
    expect(covers.ctx.getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(card.ctx.drawImage).toHaveBeenCalledExactlyOnceWith(covers.canvas, 64, 64);
    expect(card.ctx.fillText).toHaveBeenCalledWith(content.artist, 240, expect.any(Number));
  });

  it("never copies a tainted cover canvas into the export", async () => {
    const cover = mockCanvas();
    const card = mockCanvas();
    mockDocument(cover.canvas, card.canvas);
    mockImage("loaded");
    cover.ctx.getImageData.mockImplementation(() => {
      throw new DOMException("Tainted", "SecurityError");
    });
    await expect(createLyricCardPng(withCover, signal())).resolves.toBeInstanceOf(Blob);
    expect(card.ctx.drawImage).not.toHaveBeenCalled();
    expect(card.ctx.fillText).toHaveBeenCalledWith("歌名", 64, expect.any(Number));
  });

  it.each(["failed", "pending"] as const)("exports without a %s cover", async (result) => {
    vi.useFakeTimers();
    const card = mockCanvas();
    mockDocument(card.canvas);
    const image = mockImage(result);
    const exportResult = createLyricCardPng(withCover, signal());
    await vi.runAllTimersAsync();
    await expect(exportResult).resolves.toBeInstanceOf(Blob);
    expect(image.removeAttribute).toHaveBeenCalledWith("src");
    expect(card.ctx.drawImage).not.toHaveBeenCalled();
  });

  it("reports PNG encoding failure", async () => {
    const { canvas } = mockCanvas();
    mockDocument(canvas);
    canvas.toBlob.mockImplementation((complete) => complete(null));
    await expect(createLyricCardPng(content, signal())).rejects.toThrow("PNG encoding failed");
  });
});

it("cleans up the download link and object URL even when clicking fails", async () => {
  vi.useFakeTimers();
  const link = { click: vi.fn(), remove: vi.fn(), download: "", href: "" };
  const append = vi.fn();
  vi.stubGlobal("document", { createElement: () => link, body: { append } });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  link.click.mockImplementation(() => {
    throw new Error("Could not start download");
  });
  expect(() => downloadLyricCardPng(new Blob(["PNG"]), lyricCardFilename("歌/名:😀"))).toThrow(
    "Could not start download",
  );
  expect(append).toHaveBeenCalledWith(link);
  expect(link.download).toBe("HE-Music - 歌_名_😀.png");
  expect(link.remove).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(revoke).toHaveBeenCalledWith("blob:test");
});
