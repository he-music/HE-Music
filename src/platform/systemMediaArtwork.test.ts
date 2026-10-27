import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";

// Produced with Go image/png and image/jpeg from a synthetic 2×2 RGBA image.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAH0lEQVR4nAASAO3/AqoAAP8AAAAAAAAAAAAAAAAAAwAZcgGsUdag8AAAAABJRU5ErkJggg==";
const jpeg =
  "/9j/2wCEAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDIBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAIAAgMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APACSzFmJJJySe9JRRQB/9k=";
const bytes = (value = png) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const fetchMock = vi.fn<typeof fetch>();
let imageCount = 0;
let decodeFails = false;
let holdDecode = false;
let decode: (() => void) | undefined;
const revoke = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  imageCount = 0;
  decodeFails = false;
  holdDecode = false;
  decode = undefined;
  revoke.mockReset();
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://fixture.invalid/decoded");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 2;
      naturalHeight = 2;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        imageCount++;
      }
      set src(value: string) {
        if (!value) return;
        decode = () => (decodeFails ? this.onerror?.() : this.onload?.());
        if (!holdDecode) queueMicrotask(decode);
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const load = (source = "https://image.invalid/synthetic", signal = new AbortController().signal) =>
  loadSystemMediaArtwork(source, signal);

describe("systemMediaArtwork loader", () => {
  it.each([png, jpeg])(
    "streams and validates synthetic PNG/JPEG without credentials",
    async (fixture) => {
      fetchMock.mockResolvedValue(
        new Response(bytes(fixture), { headers: { "content-type": "text/plain" } }),
      );
      expect(await load()).toBe(fixture);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://image.invalid/synthetic",
        expect.objectContaining({
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(imageCount).toBe(1);
      expect(revoke).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "file:///synthetic.png",
    "javascript:0",
    "ftp://fixture.invalid/synthetic.png",
    "blob:https://other.invalid/image",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,%%%",
    "https://fixture:secret@image.invalid/synthetic",
  ])("rejects unsupported source before fetch: %s", async (source) => {
    await expect(load(source)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([`data:image/png;base64,${png}`, "blob:https://fixture.invalid/synthetic"])(
    "accepts bounded data or same-origin blob",
    async (source) => {
      fetchMock.mockResolvedValue(new Response(bytes()));
      expect(await load(source)).toBe(png);
    },
  );

  it.each([undefined, "1", "99999999"])(
    "limits the actual stream independently of Content-Length %s",
    async (declared) => {
      const cancel = vi.fn();
      let index = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            index++;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      fetchMock.mockResolvedValue(
        new Response(body, { headers: declared ? { "content-length": declared } : {} }),
      );
      await expect(load()).rejects.toThrow("budget");
      expect(cancel).toHaveBeenCalledOnce();
      expect(index).toBe(declared === "99999999" ? 0 : 3);
      expect(imageCount).toBe(0);
    },
  );

  it("cancels HTTP error bodies and rejects malformed bytes without image decode", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 403 }));
    await expect(load()).rejects.toThrow("unavailable");
    expect(cancel).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response("not a picture"));
    await expect(load()).rejects.toThrow("format");
    expect(imageCount).toBe(0);
  });

  it("rejects excessive header dimensions before creating an Image", async () => {
    const oversized = bytes();
    new DataView(oversized.buffer).setUint32(16, 100000);
    fetchMock.mockResolvedValue(new Response(oversized));
    await expect(load()).rejects.toThrow("dimensions");
    expect(imageCount).toBe(0);
  });

  it("degrades invalid/full decode failures and revokes its object URL", async () => {
    decodeFails = true;
    fetchMock.mockResolvedValue(new Response(bytes()));
    await expect(load()).rejects.toThrow("Invalid artwork image");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("aborts before fetching, while a reader is pending, and during decode", async () => {
    const before = new AbortController();
    before.abort();
    await expect(load(undefined, before.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const during = new AbortController();
    const pending = load(undefined, during.signal);
    await Promise.resolve();
    during.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    holdDecode = true;
    fetchMock.mockResolvedValueOnce(new Response(bytes()));
    const decoding = new AbortController();
    const pendingDecode = load(undefined, decoding.signal);
    for (let i = 0; i < 30 && !decode; i++) await Promise.resolve();
    expect(decode).toBeDefined();
    decoding.abort();
    await expect(pendingDecode).rejects.toMatchObject({ name: "AbortError" });
    decode?.();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
