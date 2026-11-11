import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importLocalPlaylistCover } from "./localPlaylistCover";

const cover = "data:image/jpeg;base64,imported";
const decode = vi.fn();
const canvas = {
  width: 0,
  height: 0,
  getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }),
  toDataURL: vi.fn(() => cover),
};
let width = 4096;
let height = 2048;
let createURL: ReturnType<typeof vi.spyOn>;
let revokeURL: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  width = 4096;
  height = 2048;
  decode.mockResolvedValue(undefined);
  createURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  revokeURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = width;
      naturalHeight = height;
      decode = decode;
    },
  );
  vi.stubGlobal("document", { createElement: () => canvas });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [4096, 2048, 1024, 512],
  [600, 900, 600, 900],
])(
  "导入 %s×%s 图片时限制尺寸且保持比例，不放大小图",
  async (w, h, expectedWidth, expectedHeight) => {
    width = w;
    height = h;
    const file = new File(["fixture"], "cover.png", { type: "image/png" });
    expect(await importLocalPlaylistCover(file)).toBe(cover);
    expect(canvas.width).toBe(expectedWidth);
    expect(canvas.height).toBe(expectedHeight);
    expect(revokeURL).toHaveBeenCalledWith("blob:fixture");
  },
);
it("拒绝不支持的文件、空图片及超大文件", async () => {
  for (const file of [
    new File(["text"], "cover.txt", { type: "text/plain" }),
    new File([], "empty.png", { type: "image/png" }),
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
  ])
    await expect(importLocalPlaylistCover(file)).rejects.toThrow();
  expect(createURL).not.toHaveBeenCalled();
});
it("损坏图片解码失败时仍释放临时地址", async () => {
  decode.mockRejectedValueOnce(new Error("decode failed"));
  await expect(
    importLocalPlaylistCover(new File(["broken"], "broken.jpg", { type: "image/jpeg" })),
  ).rejects.toThrow("decode failed");
  expect(revokeURL).toHaveBeenCalledWith("blob:fixture");
});
