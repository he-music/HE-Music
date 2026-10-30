import { afterEach, expect, it, vi } from "vitest";
import { LocalDownloadSession } from "./localDownloadSession";
import type { LocalDownloadSnapshot } from "./localDownloadPersistence";

const sessions: LocalDownloadSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

it("keeps captured song presentation across retries without persisting its cover or sending it to native", async () => {
  let history: readonly LocalDownloadSnapshot[] = [];
  const access = {
    current: () => true,
    start: vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
    })),
    read: vi.fn(async (id: string) => ({
      operationId: id,
      code: "network_error",
      done: true,
      committed: false,
      received: 0,
      total: 0,
    })),
    cancel: vi.fn(async (id: string) => ({
      operationId: id,
      code: "cancelled",
      done: true,
      committed: false,
      received: 0,
      total: 0,
    })),
  };
  const persistence = {
    load: async () => history,
    save: vi.fn(async (value: readonly LocalDownloadSnapshot[]) => {
      history = value;
    }),
  };
  const deps = {
    access: () => access,
    onCommitted: async () => {},
    directoryPath: () => "/Music",
    directoryToken: () => "private-grant",
    persistence,
    resolveURL: async () => ({ url: "https://audio.test/fresh", format: "mp3" }),
  };
  const session = new LocalDownloadSession(deps);
  sessions.push(session);
  await session.restored;
  const display = {
    artists: "Artist A",
    album: "Album A",
    duration: 180,
    cover: "https://img.test/runtime-cover?signature=private",
  };
  const expected = { ...display };
  const id = await session.start({
    grantToken: "private-grant",
    filename: "Song.mp3",
    label: "Song",
    quality: "320",
    source: {
      id: "song",
      platform: "test",
      name: "Song",
      links: [{ name: "320", quality: 320, format: "mp3", size: "1" }],
    },
    url: "https://audio.test/initial",
    resolveURL: deps.resolveURL,
    options: {
      relativeDirectory: "Artist/Album",
      writeMetadata: false,
      writeCover: false,
      writeLyrics: false,
      saveSidecars: false,
    },
    display,
  });
  expect(id).toBeTruthy();
  display.artists = "changed";
  display.cover = "https://img.test/replaced";
  expect(session.tasks.value[0].display).toEqual(expected);
  expect(session.tasks.value[0].target).toEqual({
    directory: "/Music",
    relativePath: "Artist/Album/Song.mp3",
  });
  expect(access.start.mock.calls[0][0]).not.toHaveProperty("display");
  expect(access.start.mock.calls[0][0]).not.toHaveProperty("target");
  await session.refresh(id!);
  const retried = await session.retry(id!);
  expect(retried).toBeTruthy();
  expect(session.tasks.value.find((task) => task.id === retried)?.display).toEqual(expected);
  await session.dispose();
  expect(persistence.save).toHaveBeenCalled();
  expect(JSON.stringify(history)).not.toMatch(/runtime-cover|signature|private-grant|https:\/\//);
  expect(history.every((task) => task.targetDirectory === "/Music")).toBe(true);
  const restored = new LocalDownloadSession(deps);
  sessions.push(restored);
  await restored.restored;
  expect(
    restored.tasks.value.every((task) => task.target?.relativePath === "Artist/Album/Song.mp3"),
  ).toBe(true);
  expect(restored.tasks.value.every((task) => task.display?.cover !== expected.cover)).toBe(true);
});
