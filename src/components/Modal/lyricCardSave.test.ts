import { afterEach, expect, it, vi } from "vitest";
import { pickLyricCardFile, supportsLyricCardPicker, writeLyricCardFile } from "./lyricCardSave";

afterEach(() => vi.unstubAllGlobals());

it("recognizes an unavailable picker and returns null only for cancellation", async () => {
  vi.stubGlobal("window", {});
  expect(supportsLyricCardPicker()).toBe(false);

  const showSaveFilePicker = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"))
    .mockRejectedValueOnce(new DOMException("blocked", "SecurityError"));
  vi.stubGlobal("window", { showSaveFilePicker });
  expect(supportsLyricCardPicker()).toBe(true);
  await expect(pickLyricCardFile("card.png")).resolves.toBeNull();
  expect(showSaveFilePicker).toHaveBeenCalledWith({
    suggestedName: "card.png",
    types: [{ description: "PNG", accept: { "image/png": [".png"] } }],
  });
  await expect(pickLyricCardFile("card.png")).rejects.toMatchObject({ name: "SecurityError" });
});

it("commits the selected file only after writing and aborts a failed write", async () => {
  const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => {}) };
  vi.stubGlobal("window", {
    showSaveFilePicker: async () => ({ createWritable: async () => stream }),
  });
  const file = await pickLyricCardFile("card.png");
  if (!file) throw new Error("Test picker did not return a file");
  const png = new Blob();
  await writeLyricCardFile(file, png, new AbortController().signal);
  expect(stream.write).toHaveBeenCalledExactlyOnceWith(png);
  expect(stream.close).toHaveBeenCalledOnce();

  stream.write.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(writeLyricCardFile(file, png, new AbortController().signal)).rejects.toThrow(
    "disk unavailable",
  );
  expect(stream.abort).toHaveBeenCalledOnce();
  expect(stream.close).toHaveBeenCalledOnce();
});
