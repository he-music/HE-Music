import { describe, expect, it, vi } from "vitest";
import {
  createLocalDownloadPersistence,
  localDownloadSnapshot,
  LOCAL_DOWNLOAD_FORMATS,
  validLocalDownloadFormat,
  type LocalDownloadSnapshot,
  type LocalDownloadStorage,
} from "./localDownloadPersistence";

const snapshot = (id = "task"): LocalDownloadSnapshot => ({
  id,
  label: "Song",
  filename: "song.flac",
  quality: "lossless",
  source: {
    id: "song",
    platform: "test",
    name: "Song",
    links: [{ name: "lossless", quality: 999, format: "flac" }],
  },
  targetDirectory: "/Music",
  phase: "active",
  done: false,
  committed: false,
  received: 2 ** 40,
  total: 2 ** 41,
});
const storage = (raw: unknown = null): LocalDownloadStorage => ({
  getItem: vi.fn(async () => raw),
  setItem: vi.fn(async () => undefined),
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each([
  "io_error",
  "invalid_request",
  "network_error",
  "http_rejected",
  "limit",
  "payload_rejected",
  "unsupported",
  "atomic_commit_failed",
] as const)("restores the allowlisted download failure reason %s", async (warning) => {
  const task = { ...snapshot(), phase: "failed" as const, done: true, warning };
  const db = storage();
  const persistence = createLocalDownloadPersistence(db);
  await persistence.load();
  await persistence.save([task]);
  const written = vi.mocked(db.setItem).mock.calls[0][1];
  expect(await createLocalDownloadPersistence(storage(written)).load()).toEqual([task]);
  expect(() => localDownloadSnapshot({ ...task, warning: "raw private error" })).toThrow();
});

describe("localDownloadPersistence", () => {
  it("round trips allowlisted metadata without authorization, URLs or runtime state", async () => {
    const db = storage();
    const persistence = createLocalDownloadPersistence(db);
    await persistence.load();
    const input = {
      ...snapshot(),
      grantToken: "SECRET_TOKEN",
      epoch: 99,
      url: "https://signed.example/SECRET_URL",
      gateway: "SECRET_GATEWAY",
      ref: { fileId: "SECRET_REF" },
      resolveURL: () => "SECRET_CLOSURE",
      source: {
        ...snapshot().source!,
        token: "SECRET_SOURCE",
        links: [
          {
            name: "lossless",
            quality: 999,
            format: "flac",
            url: "SECRET_LINK",
            size: "SECRET_SIZE",
          },
        ],
      },
    };
    await persistence.save([input]);
    const written = vi.mocked(db.setItem).mock.calls[0][1];
    expect(JSON.stringify(written)).not.toMatch(/SECRET|grantToken|epoch|resolveURL|gateway|"ref"/);
    expect(written).toEqual({ version: 1, tasks: [snapshot()] });
    expect(await createLocalDownloadPersistence(storage(written)).load()).toEqual([snapshot()]);
  });

  it("supports DFF and safe byte counts above 32 MiB", () => {
    expect(LOCAL_DOWNLOAD_FORMATS).toContain("dff");
    expect(LOCAL_DOWNLOAD_FORMATS).toHaveLength(12);
    for (const format of LOCAL_DOWNLOAD_FORMATS) {
      expect(validLocalDownloadFormat(format.toUpperCase())).toBe(true);
      expect(
        localDownloadSnapshot({
          ...snapshot(),
          source: {
            ...snapshot().source!,
            links: [{ name: "quality", quality: 1, format }],
          },
        }).received,
      ).toBe(2 ** 40);
    }
    expect(validLocalDownloadFormat("exe")).toBe(false);
  });

  it("serializes writes and captures each snapshot before the queue runs", async () => {
    const first = deferred();
    const db = storage();
    vi.mocked(db.setItem).mockImplementationOnce(async () => first.promise);
    const persistence = createLocalDownloadPersistence(db);
    await persistence.load();
    const mutable = { ...snapshot("first") };
    const save1 = persistence.save([mutable]);
    mutable.label = "changed after save";
    const save2 = persistence.save([snapshot("second")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(db.setItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.setItem).mock.calls[0][1]).toEqual({
      version: 1,
      tasks: [snapshot("first")],
    });
    first.resolve();
    await Promise.all([save1, save2]);
    expect(vi.mocked(db.setItem).mock.calls[1][1]).toEqual({
      version: 1,
      tasks: [snapshot("second")],
    });
  });

  it("reports write failures and allows a later write to recover", async () => {
    const db = storage();
    vi.mocked(db.setItem).mockRejectedValueOnce(new Error("disk full"));
    const persistence = createLocalDownloadPersistence(db);
    await persistence.load();
    await expect(persistence.save([snapshot()])).rejects.toThrow("disk full");
    await expect(persistence.save([])).resolves.toBeUndefined();
    expect(db.setItem).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { version: 9, tasks: [] },
    { version: 1, tasks: [snapshot(), snapshot()] },
    { version: 1, tasks: [{ ...snapshot(), received: -1 }] },
    { version: 1, tasks: [{ ...snapshot(), total: Number.MAX_SAFE_INTEGER + 1 }] },
    { version: 1, tasks: [{ ...snapshot(), phase: "success", done: true }] },
    { version: 1, tasks: [{ ...snapshot(), done: true }] },
    { version: 1, tasks: [{ ...snapshot(), source: { links: [] } }] },
  ])("preserves corrupt data and refuses subsequent overwrites: %j", async (raw) => {
    const db = storage(raw);
    const persistence = createLocalDownloadPersistence(db);
    await expect(persistence.load()).rejects.toThrow("原始数据已保留");
    await expect(persistence.save([])).rejects.toThrow("未覆盖已有数据");
    expect(db.setItem).not.toHaveBeenCalled();
  });

  it("does not overwrite on read failures or before a successful read", async () => {
    const db = storage();
    vi.mocked(db.getItem).mockRejectedValue(new Error("read failure"));
    const persistence = createLocalDownloadPersistence(db);
    await expect(persistence.save([])).rejects.toThrow("未覆盖已有数据");
    await expect(persistence.load()).rejects.toThrow("read failure");
    await expect(persistence.save([])).rejects.toThrow("未覆盖已有数据");
    expect(db.setItem).not.toHaveBeenCalled();
  });
});
