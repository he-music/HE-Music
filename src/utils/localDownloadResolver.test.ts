import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/song", () => ({ songDetail: vi.fn(), songLyric: vi.fn(), songUrl: vi.fn() }));
import { createMygoDownloadResolver } from "./localDownloadResolver";

const source = {
  id: "song",
  platform: "qq",
  name: "Song",
  links: [{ name: "320", quality: 320, format: "mp3", size: "1" }],
};

describe("mygo local download resolver candidate", () => {
  it("resolves a fresh URL and metadata without exposing credentials in source", async () => {
    const resolve = createMygoDownloadResolver(
      vi.fn(async () => ({ url: "https://cdn.test/signed?token=x", format: "mp3" })),
      vi.fn(async () => ({
        song: {
          id: "song",
          name: "Fresh",
          subtitle: "",
          duration: 1,
          mv_id: "",
          artists: [{ id: "artist", name: "Artist" }],
          album: { id: "album", name: "Album" },
          links: [],
          platform: "qq",
          cover: "https://img.test/c.jpg",
        },
      })),
      vi.fn(async () => ({
        lyric: "[00:01.00]<0,200>Hello<200,300> world",
        trans: "translation",
        roma: "romaji",
      })),
    );
    await expect(
      resolve(
        "320",
        source,
        {
          writeMetadata: true,
          writeCover: true,
          writeLyrics: true,
          saveSidecars: false,
        },
        { writeLyricTranslation: true, writeLyricRomaji: true },
      ),
    ).resolves.toMatchObject({
      format: "mp3",
      metadata: {
        title: "Fresh",
        lyrics: "[00:01.00]Hello world",
        coverURL: "https://img.test/c.jpg",
      },
    });
  });

  it("does not fetch optional metadata for an audio-only request", async () => {
    const detail = vi.fn();
    const lyric = vi.fn();
    const resolve = createMygoDownloadResolver(
      vi.fn(async () => ({ url: "https://cdn.test/audio", format: "mp3" })),
      detail,
      lyric,
    );
    await expect(
      resolve("320", source, {
        writeMetadata: false,
        writeCover: false,
        writeLyrics: false,
        saveSidecars: false,
      }),
    ).resolves.toMatchObject({ format: "mp3" });
    expect(detail).not.toHaveBeenCalled();
    expect(lyric).not.toHaveBeenCalled();
  });

  it("makes malformed or unavailable responses visible as a stable error", async () => {
    const resolve = createMygoDownloadResolver(
      vi.fn(async () => ({ url: "file:///unsafe", format: "mp3" })),
    );
    await expect(resolve("320", source)).rejects.toThrow("Download source unavailable");
  });
});

it("rejects before queueing when a required cover cannot be resolved", async () => {
  const resolve = createMygoDownloadResolver(
    vi.fn(async () => ({ url: "https://cdn.test/audio", format: "mp3" })),
    vi.fn(async () => {
      throw new Error("detail down");
    }),
  );
  await expect(
    resolve("320", source, {
      writeMetadata: true,
      writeCover: true,
      writeLyrics: false,
      saveSidecars: false,
    }),
  ).rejects.toThrow("Download cover unavailable");
});

it("keeps captured metadata when fresh detail is unavailable", async () => {
  const resolve = createMygoDownloadResolver(
    vi.fn(async () => ({ url: "https://cdn.test/audio", format: "mp3" })),
    vi.fn(async () => {
      throw new Error("detail down");
    }),
  );
  await expect(
    resolve("320", source, {
      writeMetadata: true,
      writeCover: false,
      writeLyrics: false,
      saveSidecars: false,
      metadata: { title: "Captured", artists: ["Artist"], album: "Album", lyrics: "Known" },
    }),
  ).resolves.toMatchObject({
    metadata: { title: "Captured", artists: ["Artist"], album: "Album", lyrics: "Known" },
  });
});

it("converts captured lyrics when fetching fresh lyrics fails after restoring a task", async () => {
  const resolve = createMygoDownloadResolver(
    vi.fn(async () => ({ url: "https://cdn.test/audio", format: "mp3" })),
    vi.fn(async () => {
      throw new Error("detail unavailable");
    }),
    vi.fn(async () => {
      throw new Error("lyrics unavailable");
    }),
  );
  const result = await resolve(
    "320",
    source,
    {
      writeMetadata: true,
      writeCover: false,
      writeLyrics: true,
      saveSidecars: true,
      metadata: {
        title: "Title",
        artists: [],
        album: "",
        lyrics: "[00:01.00]<0,200>原文\n\n[lang:trans]\n翻译",
      },
    },
    { writeLyricTranslation: true, writeLyricRomaji: true },
  );
  expect(result.metadata?.lyrics).toBe("[00:01.00]原文");
});

it.each([
  "file:///unsafe.jpg",
  "https://%65xample.com/cover.jpg",
  "https://user:pass@img.test/cover.jpg",
  "https://img.test/cover.jpg#fragment",
  "https:///cover.jpg",
  "http:opaque",
  `https://img.test/${"x".repeat(8200)}`,
])("rejects an invalid required cover URL before queueing: %s", async (coverURL) => {
  const resolve = createMygoDownloadResolver(
    vi.fn(async () => ({ url: "https://cdn.test/audio", format: "mp3" })),
    vi.fn(async () => ({
      song: {
        id: "song",
        name: "Fresh",
        subtitle: "",
        duration: 1,
        mv_id: "",
        links: [],
        platform: "qq",
        artists: [],
        album: "",
        cover: coverURL,
      },
    })),
  );
  await expect(
    resolve("320", source, {
      writeMetadata: true,
      writeCover: true,
      writeLyrics: false,
      saveSidecars: false,
    }),
  ).rejects.toThrow("Download cover unavailable");
});
