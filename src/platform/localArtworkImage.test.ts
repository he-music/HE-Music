import { describe, expect, it, vi } from "vitest";
import { admitLocalArtworkImage } from "./localArtworkImage";
import type { Picture } from "./mygo.bindings";

// 合成头仅用于 header admission，不代表浏览器可解码的完整图片。
function png(width = 1, height = 1, size = 33): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width = 1, height = 1, marker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    marker,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
}

function picture(bytes = png(), MIME = "image/png", Type = 0): Picture {
  return { MIME, Type, Description: "", Data: Buffer.from(bytes).toString("base64") };
}

function admit(bytes: Uint8Array, mime = "image/png") {
  return admitLocalArtworkImage([picture(bytes, mime)]);
}

describe("localArtworkImage header admission", () => {
  it("returns independent bytes and canonical MIME, selects valid front cover first", () => {
    const normal = picture(png(10));
    const front = picture(jpeg(20), "image/jpeg", 3);
    const first = admitLocalArtworkImage([normal, { ...front, Data: "bad" }, front]);
    expect(first?.mime).toBe("image/jpeg");
    expect(first?.bytes).toEqual(jpeg(20));
    first!.bytes.fill(0);
    expect(admitLocalArtworkImage([front])?.bytes).toEqual(jpeg(20));
    expect(admitLocalArtworkImage([{ ...front, Data: "bad" }, normal])?.mime).toBe("image/png");
  });

  it("checks only the first 32 candidates and handles no image", () => {
    const bad = { ...picture(), Data: "" };
    expect(admitLocalArtworkImage([])).toBeUndefined();
    expect(
      admitLocalArtworkImage([...Array.from({ length: 32 }, () => bad), picture()]),
    ).toBeUndefined();
    expect(
      admitLocalArtworkImage([...Array.from({ length: 31 }, () => bad), picture()]),
    ).toBeDefined();
  });

  it.each([
    "image/svg+xml",
    "text/html",
    "image/jpg",
    "IMAGE/PNG",
    "image/png;foo=bar",
    "https://x",
    "",
  ])("rejects unsupported MIME %s", (mime) => expect(admit(png(), mime)).toBeUndefined());

  it("requires MIME and magic to agree", () => {
    expect(admit(png(), "image/jpeg")).toBeUndefined();
    expect(admit(jpeg(), "image/png")).toBeUndefined();
    expect(admit(new TextEncoder().encode("<html>"))).toBeUndefined();
    expect(admit(new TextEncoder().encode("https://image"))).toBeUndefined();
  });

  it.each([
    "",
    "AA",
    "A===",
    "AA=A",
    "====",
    "AAAA\n",
    "AAAA ",
    "AA-_",
    "AB==",
    "AAB=",
    "data:image/png;base64,AAAA",
  ])("rejects noncanonical base64 %j before decoding", (Data) => {
    const decoder = vi.spyOn(globalThis, "atob");
    try {
      expect(admitLocalArtworkImage([{ ...picture(), Data }])).toBeUndefined();
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
    }
  });

  it("accepts canonical padding variants", () => {
    for (const size of [33, 34, 35]) expect(admit(png(1, 1, size))).toBeDefined();
  });

  it("caps encoded length and decoded bytes before atob, accepts exactly 4 MiB", () => {
    expect(admit(png(1, 1, 4 * 1024 * 1024))).toBeDefined();
    const decoder = vi.spyOn(globalThis, "atob");
    try {
      expect(admit(png(1, 1, 4 * 1024 * 1024 + 1))).toBeUndefined();
      expect(
        admitLocalArtworkImage([{ ...picture(), Data: "A".repeat(6_000_000) }]),
      ).toBeUndefined();
      expect(decoder).not.toHaveBeenCalled();
    } finally {
      decoder.mockRestore();
    }
  });

  it("fails closed if atob throws", () => {
    const decoder = vi.spyOn(globalThis, "atob").mockImplementation(() => {
      throw new Error();
    });
    try {
      expect(admit(png())).toBeUndefined();
    } finally {
      decoder.mockRestore();
    }
  });

  it("checks PNG IHDR, truncation and dimensions", () => {
    expect(admit(png(4000, 4000))).toBeDefined();
    expect(admit(png(4096, 1))).toBeDefined();
    for (const [w, h] of [
      [0, 1],
      [1, 0],
      [4097, 1],
      [1, 4097],
      [4096, 4096],
      [0xffffffff, 1],
    ]) {
      expect(admit(png(w, h))).toBeUndefined();
    }
    expect(admit(png().slice(0, 32))).toBeUndefined();
    for (const offset of [0, 8, 12]) {
      const bytes = png();
      bytes[offset] ^= 1;
      expect(admit(bytes)).toBeUndefined();
    }
  });

  it("checks JPEG SOF, segment bounds, marker classes and dimensions", () => {
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc9, 0xcf]) {
      expect(admit(jpeg(4096, 1, marker), "image/jpeg")).toBeDefined();
    }
    for (const [w, h] of [
      [0, 1],
      [1, 0],
      [4097, 1],
      [1, 4097],
      [4096, 4096],
    ]) {
      expect(admit(jpeg(w, h), "image/jpeg")).toBeUndefined();
    }
    for (const marker of [0, 0xc4, 0xc8, 0xcc, 0xd8, 0xd9, 0xda]) {
      expect(admit(jpeg(1, 1, marker), "image/jpeg")).toBeUndefined();
    }
    for (const size of [0, 2, 4, 6, 14])
      expect(admit(jpeg().slice(0, size), "image/jpeg")).toBeUndefined();
    for (const [offset, value] of [
      [4, 255],
      [5, 1],
      [11, 0],
      [11, 2],
    ]) {
      const bytes = jpeg();
      bytes[offset] = value;
      expect(admit(bytes, "image/jpeg")).toBeUndefined();
    }
    const withApp = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xe0, 0, 4, 0, 0, ...jpeg().slice(2)]);
    expect(admit(withApp, "image/jpeg")).toBeDefined();
  });

  it("does not scan JPEG beyond 256 KiB", () => {
    const segment = new Uint8Array(65537);
    segment.set([0xff, 0xe1, 0xff, 0xff]);
    const bytes = new Uint8Array(2 + segment.length * 4 + jpeg().length - 2);
    bytes.set([0xff, 0xd8]);
    for (let i = 0; i < 4; i++) bytes.set(segment, 2 + i * segment.length);
    bytes.set(jpeg().slice(2), 2 + 4 * segment.length);
    expect(admit(bytes, "image/jpeg")).toBeUndefined();
  });
});
