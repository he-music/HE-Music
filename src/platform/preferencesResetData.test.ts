import { afterEach, expect, it, vi } from "vitest";
import { FilesSession, filesSession } from "./filesSession";
import { executePreferencesReset } from "./preferencesReset";
import { clearAdditionalPreferencesData } from "./preferencesResetData";
import type { PlatformFiles } from "./files";

// In-memory backend for the real persistence adapter. No browser/user DB is opened.
const backend = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  order: [] as string[],
  saveGate: Promise.resolve(),
  drop: vi.fn<(options: { name: string; storeName: string }) => Promise<void>>(async () => {}),
}));
vi.mock("localforage", () => ({
  default: {
    createInstance: (options: { name: string; storeName: string }) => ({
      getItem: async (key: string) =>
        backend.data.get(`${options.name}/${options.storeName}/${key}`) ?? null,
      setItem: async (key: string, value: unknown) => {
        backend.order.push("save started");
        await backend.saveGate;
        backend.data.set(`${options.name}/${options.storeName}/${key}`, value);
        backend.order.push("save completed");
      },
    }),
    dropInstance: (options: { name: string; storeName: string }) => backend.drop(options),
  },
}));

afterEach(async () => {
  await filesSession.value?.dispose();
  backend.data.clear();
  backend.order.length = 0;
  backend.saveGate = Promise.resolve();
  vi.resetAllMocks();
});

it("real FilesSession drains an old history save before clearing only the three extra app stores", async () => {
  const historyKey = "local-data/local_download_history/history-v1";
  const snapshot = (id: string) => ({
    id,
    label: id,
    filename: `${id}.mp3`,
    quality: "320",
    targetDirectory: "/fixture/Music",
    phase: "success",
    done: true,
    committed: true,
    received: 1,
    total: 1,
  });
  backend.data.set(historyKey, { version: 1, tasks: [snapshot("A"), snapshot("B")] });
  backend.data.set("local-data/local/local-songs", ["cached row"]);
  backend.data.set("background-data/background/image", "cached blob");
  backend.data.set("unrelated/database/key", "untouched");
  backend.drop.mockImplementation(async ({ name, storeName }) => {
    backend.order.push(`drop ${name}/${storeName}`);
    for (const key of backend.data.keys())
      if (key.startsWith(`${name}/${storeName}/`)) backend.data.delete(key);
  });
  const provider: PlatformFiles = {
    begin: async () => ({ epoch: 1 }),
    chooseDirectory: vi.fn(),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: vi.fn(async () => {}),
    startDownload: vi.fn(),
    readDownloadState: vi.fn(),
    cancelDownload: vi.fn(),
  };
  const session = new FilesSession(provider, {
    blockAudio: () => () => {},
    resolveURL: async () => ({ url: "https://fixture.test/song", format: "mp3" }),
  });
  await session.start();
  expect(filesSession.value).toBe(session);
  let finish: (() => void) | undefined;
  backend.saveGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  expect(await session.downloads?.retire("A")).toBe(true);
  await vi.waitFor(() => expect(backend.order).toContain("save started"));
  const restart = vi.fn(async () => {});
  const task = executePreferencesReset({
    mode: "all",
    native: {
      reset: async () => ({
        pending: true,
        restartRequired: true,
        transactionId: "tx",
        mode: "all",
      }),
    },
    current: () => true,
    clearRenderer: async () => {
      await session.dispose();
      await clearAdditionalPreferencesData();
    },
    restart,
    reportRendererFailure: vi.fn(),
  });
  await vi.waitFor(() => expect(session.ready.value).toBe(false));
  expect(backend.drop).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  finish?.();
  expect(await task).toEqual({ status: "scheduled", rendererFailed: false, restartFailed: false });
  expect(backend.order.slice(-3)).toEqual([
    "drop local-data/local_download_history",
    "drop local-data/local",
    "drop background-data/background",
  ]);
  expect(backend.order.lastIndexOf("save completed")).toBeLessThan(
    backend.order.indexOf("drop local-data/local_download_history"),
  );
  expect(backend.order.filter((entry) => entry === "save started").length).toBe(
    backend.order.filter((entry) => entry === "save completed").length,
  );
  expect(backend.data.has(historyKey)).toBe(false);
  expect([...backend.data]).toEqual([["unrelated/database/key", "untouched"]]);
  expect(restart).toHaveBeenCalledOnce();
});
