import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDownloadSession } from "./localDownloadSession";
import type { LocalDownloadPersistence, LocalDownloadSnapshot } from "./localDownloadPersistence";

const options = {
  relativeDirectory: "Artist/Album",
  writeMetadata: true,
  writeCover: true,
  writeLyrics: true,
  saveSidecars: false,
  metadata: {
    title: "Title",
    artists: ["Artist"],
    album: "Album",
    lyrics: "",
    coverURL: "https://img.test/cover",
  },
};
const resolveOptions = { writeLyricTranslation: true, writeLyricRomaji: false };

describe("download strategy capture", () => {
  let session: LocalDownloadSession | undefined;
  afterEach(() => session?.dispose());

  it("sends captured options and passes the same strategy to retry resolution", async () => {
    const access = {
      current: () => true,
      start: vi.fn(async (request: { operationId: string }) => ({
        operationId: request.operationId,
      })),
      read: vi.fn(async (id: string) => ({
        operationId: id,
        code: "network_error",
        done: true,
        received: 0,
        total: 0,
        committed: false,
      })),
      cancel: vi.fn(async (id: string) => ({
        operationId: id,
        code: "cancelled",
        done: true,
        received: 0,
        total: 0,
        committed: false,
      })),
    };
    const resolveURL = vi.fn(async () => ({
      url: "https://cdn.test/fresh",
      format: "mp3",
      metadata: options.metadata,
    }));
    session = new LocalDownloadSession({
      access: () => access,
      onCommitted: async () => {},
      resolveURL,
    });
    await session.restored;
    const id = await session.start({
      grantToken: "grant",
      filename: "Artist - Title.mp3",
      url: "https://cdn.test/old",
      label: "Title",
      quality: "320",
      source: {
        id: "song",
        platform: "qq",
        name: "Title",
        links: [{ name: "320", quality: 320, format: "mp3", size: "1" }],
      },
      resolveURL,
      options,
      resolveOptions,
    });
    expect(access.start).toHaveBeenCalledWith(expect.objectContaining({ options }));
    await session.refresh(id!);
    const firstRetry = await session.retry(id!);
    expect(firstRetry).toBeTruthy();
    await session.refresh(firstRetry!);
    const secondRetry = await session.retry(firstRetry!);
    expect(secondRetry).toBeTruthy();
    expect(resolveURL).toHaveBeenCalledTimes(2);
    for (const call of resolveURL.mock.calls)
      expect(call).toEqual([
        "320",
        expect.anything(),
        expect.objectContaining({ writeCover: true, relativeDirectory: "Artist/Album" }),
        resolveOptions,
      ]);
  });
});

it("accepts a committed durability-uncertain subdirectory ref and scans once", async () => {
  const onCommitted = vi.fn(async () => {});
  const access = {
    current: () => true,
    start: vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
    })),
    read: vi.fn(async (id: string) => ({
      operationId: id,
      code: "durability_uncertain",
      done: true,
      received: 4,
      total: 4,
      committed: true,
      filename: "Artist - Title.mp3",
      ref: {
        grantToken: "grant",
        relativePath: "Artist/Album/Artist - Title.mp3",
        fileId: "fresh",
        version: "v1",
      },
    })),
    cancel: vi.fn(async (id: string) => ({
      operationId: id,
      code: "cancelled",
      done: true,
      received: 0,
      total: 0,
      committed: false,
    })),
  };
  const session = new LocalDownloadSession({ access: () => access, onCommitted });
  await session.restored;
  await session.start({
    grantToken: "grant",
    filename: "Artist - Title.mp3",
    url: "https://cdn.test/audio",
    label: "Title",
    quality: "320",
    source: {
      id: "song",
      platform: "qq",
      name: "Title",
      links: [{ name: "320", quality: 320, format: "mp3", size: "1" }],
    },
    resolveURL: async () => ({ url: "https://cdn.test/fresh", format: "mp3" }),
    options,
  });
  await session.refresh(session.tasks.value[0].id);
  expect(session.tasks.value[0]).toMatchObject({
    phase: "saved",
    done: true,
    committed: true,
    retryable: false,
  });
  expect(onCommitted).toHaveBeenCalledOnce();
  await session.dispose();
});

it.each([
  ["partial_committed", true, true, "saved", false],
  ["sync_failed", true, true, "saved", false],
  ["cleanup_failed", false, false, "failed", false],
  ["cleanup_failed", true, true, "saved", false],
  ["registration_failed", true, false, "saved", false],
  ["conflict", true, false, "saved", false],
  ["cancelled", true, false, "saved", false],
  ["timeout", true, false, "saved", false],
  ["revoked", true, false, "saved", false],
] as const)(
  "maps %s committed=%s ref=%s to %s without retry=%s",
  async (code, committed, hasRef, phase, retryable) => {
    const onCommitted = vi.fn(async () => {});
    const access = {
      current: () => true,
      start: vi.fn(async (request: { operationId: string }) => ({
        operationId: request.operationId,
      })),
      read: vi.fn(async (id: string) => ({
        operationId: id,
        code,
        done: true,
        received: 1,
        total: 1,
        committed,
        ...(hasRef
          ? {
              ref: {
                grantToken: "grant",
                relativePath: "Artist/Album/song.mp3",
                fileId: "fresh",
                version: "v1",
              },
            }
          : {}),
      })),
      cancel: vi.fn(async (id: string) => ({
        operationId: id,
        code: "cancelled",
        done: true,
        received: 0,
        total: 0,
        committed: false,
      })),
    };
    const session = new LocalDownloadSession({ access: () => access, onCommitted });
    await session.restored;
    const id = await session.start({
      grantToken: "grant",
      filename: "song.mp3",
      url: "https://cdn.test/audio",
      label: "Song",
      quality: "320",
      source: {
        id: "song",
        platform: "qq",
        name: "Song",
        links: [{ name: "320", quality: 320, format: "mp3", size: "1" }],
      },
      resolveURL: async () => ({ url: "https://cdn.test/fresh", format: "mp3" }),
      options: { ...options, relativeDirectory: "Artist/Album" },
    });
    await session.refresh(id!);
    expect(session.tasks.value[0]).toMatchObject({ phase, retryable, warning: code });
    expect(onCommitted).toHaveBeenCalledTimes(committed ? 1 : 0);
    await session.dispose();
  },
);

it("restores history and keeps resolve options across two archived retries", async () => {
  const persistence: LocalDownloadPersistence = {
    load: vi.fn(async () => [
      {
        id: "old",
        label: "Song",
        filename: "song.mp3",
        quality: "320",
        source: {
          id: "song",
          platform: "qq",
          name: "Song",
          links: [{ name: "320", quality: 320, format: "mp3" }],
        },
        targetDirectory: "/Music",
        phase: "failed",
        done: true,
        committed: false,
        received: 0,
        total: 0,
        options,
        resolveOptions,
      } as LocalDownloadSnapshot,
    ]),
    save: vi.fn(async () => {}),
  };
  const access = {
    current: () => true,
    start: vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
    })),
    read: vi.fn(async (id: string) => ({
      operationId: id,
      code: "network_error",
      done: true,
      received: 0,
      total: 0,
      committed: false,
    })),
    cancel: vi.fn(async (id: string) => ({
      operationId: id,
      code: "cancelled",
      done: true,
      received: 0,
      total: 0,
      committed: false,
    })),
  };
  const resolveURL = vi.fn(async () => ({
    url: "https://cdn.test/fresh",
    format: "mp3",
    metadata: options.metadata,
  }));
  const session = new LocalDownloadSession({
    persistence,
    access: () => access,
    onCommitted: async () => {},
    directoryToken: () => "grant",
    directoryPath: () => "/Music",
    resolveURL,
  });
  await session.restored;
  const first = await session.retry("old");
  expect(first).toBeTruthy();
  await session.refresh(first!);
  const second = await session.retry(first!);
  expect(second).toBeTruthy();
  expect(resolveURL).toHaveBeenCalledTimes(2);
  for (const call of resolveURL.mock.calls)
    expect(call).toEqual([
      "320",
      expect.anything(),
      expect.objectContaining({ writeCover: true, relativeDirectory: "Artist/Album" }),
      resolveOptions,
    ]);
  expect(access.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ options }));
  expect(access.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ options }));
  await session.dispose();
});

it.each([
  { ...options, metadata: { ...options.metadata, coverURL: "file:///cover" } },
  { ...options, metadata: { ...options.metadata, coverURL: "https://user:pass@img.test/cover" } },
  { ...options, metadata: { ...options.metadata, coverURL: "http:opaque" } },
  { ...options, metadata: { ...options.metadata, coverURL: "https://img.test/cover#fragment" } },
  { ...options, metadata: { ...options.metadata, title: "中".repeat(1366) } },
  {
    ...options,
    metadata: { ...options.metadata, artists: Array.from({ length: 65 }, () => "Artist") },
  },
  { ...options, metadata: { ...options.metadata, lyrics: "x".repeat((1 << 20) + 1) } },
  { ...options, relativeDirectory: "中".repeat(81) },
])(
  "rejects invalid static config before creating a job ($relativeDirectory)",
  async (invalidOptions) => {
    const start = vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
    }));
    const read = vi.fn();
    const session = new LocalDownloadSession({
      access: () => ({ current: () => true, start, read, cancel: read }),
      onCommitted: async () => {},
    });
    expect(
      await session.start({
        grantToken: "grant",
        filename: "song.mp3",
        url: "https://cdn.test/audio?signature=a%2Fb",
        label: "Song",
        quality: "320",
        source: { id: "song", platform: "qq", name: "Song", links: [] },
        resolveURL: async () => ({ url: "https://cdn.test/audio", format: "mp3" }),
        options: invalidOptions,
      }),
    ).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(session.tasks.value).toEqual([]);
    await session.dispose();
  },
);

it.each([
  "http:opaque",
  "https:///missing-host",
  "https://@cdn.test/audio",
  "https://user:pass@cdn.test/audio",
  "https://cdn.test/audio#fragment",
  " https://cdn.test/audio",
  "https://cdn.test/a\nb",
  "https://cdn.test/%xx",
  "https://%65xample.com/audio",
  "https://cdn.test/" + "x".repeat(8192),
])("does not call Start for invalid audio URL case %#", async (url) => {
  const start = vi.fn();
  const read = vi.fn();
  const session = new LocalDownloadSession({
    access: () => ({ current: () => true, start, read, cancel: read }),
    onCommitted: async () => {},
  });
  expect(
    await session.start({
      grantToken: "grant",
      filename: "song.mp3",
      url,
      label: "Song",
      quality: "320",
      source: { id: "song", platform: "qq", name: "Song", links: [] },
      resolveURL: async () => ({ url: "https://cdn.test/audio", format: "mp3" }),
    }),
  ).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
  expect(session.tasks.value).toEqual([]);
  await session.dispose();
});

it("sends legal encoded paths and signed queries unchanged", async () => {
  const start = vi.fn(async (request: { operationId: string }) => ({
    operationId: request.operationId,
  }));
  const read = vi.fn();
  const session = new LocalDownloadSession({
    access: () => ({ current: () => true, start, read, cancel: read }),
    onCommitted: async () => {},
  });
  const url = "https://cdn.test/audio%20file?signature=a%2Fb%2Bc&key=%65xample&order=2&order=1";
  const coverURL = "https://img.test/cover%20file?signature=c%2Fd%2Be&key=%65xample";
  const id = await session.start({
    grantToken: "grant",
    filename: "song.mp3",
    url,
    label: "Song",
    quality: "320",
    source: { id: "song", platform: "qq", name: "Song", links: [] },
    resolveURL: async () => ({ url, format: "mp3" }),
    options: { ...options, metadata: { ...options.metadata, coverURL } },
  });
  expect(id).toBeTruthy();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      url,
      options: expect.objectContaining({ metadata: expect.objectContaining({ coverURL }) }),
    }),
  );
  await session.dispose();
});
