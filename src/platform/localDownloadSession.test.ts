import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalDownloadSession,
  validDownloadFilename,
  type LocalDownloadAccess,
} from "./localDownloadSession";
import type { DownloadRequest, DownloadState } from "./mygo.bindings";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const input = {
  grantToken: "grant",
  filename: "song.mp3",
  label: "Song",
  quality: "320mp3",
  source: {
    id: "song",
    platform: "test",
    name: "Song",
    links: [{ name: "320mp3", quality: 320, format: "mp3", size: "1" }],
  },
  resolveURL: async () => ({ url: "https://example.test/fresh", format: "mp3" }),
  url: "https://example.test/audio?secret=SIGNED",
};
const state = (id: string, extra: Partial<DownloadState> = {}): DownloadState => ({
  operationId: id,
  filename: "song.mp3",
  code: "running",
  done: false,
  committed: false,
  received: 0,
  total: 0,
  ...extra,
});
const ref = { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "version" };
let session: LocalDownloadSession;
let access: LocalDownloadAccess;
let current: boolean;
let onCommitted: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  vi.useFakeTimers();
  current = true;
  access = {
    current: () => current,
    start: vi.fn(async (request: DownloadRequest) => ({ operationId: request.operationId })),
    read: vi.fn(async (id: string) => state(id)),
    cancel: vi.fn(async (id: string) => state(id, { code: "cancelled" })),
  };
  onCommitted = vi.fn(async () => {});
  session = new LocalDownloadSession({ access: () => (current ? access : undefined), onCommitted });
});
afterEach(async () => {
  session.dispose();
  await vi.advanceTimersByTimeAsync(3001);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("localDownloadSession", () => {
  it("recovers lost and late Start only with original-ID reads, including notfound", async () => {
    const start = deferred<{ operationId: string }>();
    vi.mocked(access.start).mockReturnValue(start.promise);
    vi.mocked(access.read).mockRejectedValueOnce(new Error("notfound secret"));
    const pending = session.start(input);
    await vi.advanceTimersByTimeAsync(3000);
    const id = (await pending)!;
    expect(session.tasks.value[0].phase).toBe("unknown");
    await vi.advanceTimersByTimeAsync(250);
    expect(session.tasks.value[0].phase).toBe("unknown");
    await vi.advanceTimersByTimeAsync(250);
    expect(access.read).toHaveBeenLastCalledWith(id);
    start.resolve({ operationId: "foreign" });
    await vi.advanceTimersByTimeAsync(0);
    expect(access.start).toHaveBeenCalledTimes(1);
    expect(session.tasks.value[0].phase).toBe("active");
    expect(JSON.stringify(session.tasks.value)).not.toMatch(/SIGNED|grantToken|https|"ref":/);
  });
  it("caps full bytes at 99, keeps unknown total, and latches Done once", async () => {
    const id = (await session.start(input))!;
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { received: 5 }));
    await session.refresh(id);
    expect(session.tasks.value[0]).toMatchObject({ received: 5, total: 0, percent: undefined });
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { received: 10, total: 10 }));
    await session.refresh(id);
    expect(session.tasks.value[0].percent).toBe(99);
    vi.mocked(access.read).mockResolvedValue(
      state(id, { received: 10, total: 10, done: true, code: "ok", committed: true, ref }),
    );
    await session.refresh(id);
    await session.refresh(id);
    await session.cancel(id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.tasks.value[0]).toMatchObject({
      percent: 100,
      phase: "success",
      refresh: "complete",
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
  it("keeps cancellation pending in the two slots and reports late committed cancellation", async () => {
    const id = (await session.start(input))!;
    await session.cancel(id);
    await session.start({ ...input, filename: "second.mp3" });
    expect(await session.start(input)).toBeUndefined();
    expect(session.tasks.value[0].done).toBe(false);
    vi.mocked(access.read).mockResolvedValue(
      state(id, { done: true, code: "cancelled", committed: true }),
    );
    await session.refresh(id);
    expect(session.tasks.value[0]).toMatchObject({
      phase: "saved",
      retryable: false,
      committed: true,
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
  it("fails refresh separately from a saved file and permits new IDs only for explicit new starts", async () => {
    const id = (await session.start(input))!;
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "network_error" }));
    await session.refresh(id);
    expect(session.tasks.value[0].retryable).toBe(true);
    const next = (await session.start({ ...input, url: "https://example.test/fresh" }))!;
    expect(next).not.toBe(id);
    onCommitted.mockRejectedValue(new Error("private details"));
    vi.mocked(access.read).mockResolvedValue(
      state(next, { done: true, code: "ok", committed: true, ref }),
    );
    await session.refresh(next);
    expect(session.tasks.value[1]).toMatchObject({
      phase: "success",
      refresh: "failed",
      retryable: false,
    });
  });
  it("rejects foreign targets and regressive/unsafe bytes, and discards stale request responses", async () => {
    const id = (await session.start(input))!;
    const old = deferred<DownloadState>();
    vi.mocked(access.read).mockReturnValueOnce(old.promise);
    const reading = session.refresh(id);
    await session.cancel(id);
    old.resolve(state(id, { done: true, code: "ok", committed: true, ref }));
    await reading;
    expect(session.tasks.value[0].done).toBe(false);
    for (const extra of [
      { operationId: "foreign" },
      { received: 2 ** 40 },
      { done: true, code: "ok", committed: true, ref: { ...ref, grantToken: "foreign" } },
      { filename: "other.mp3" },
    ]) {
      vi.mocked(access.read).mockResolvedValueOnce(state(id, extra));
      await session.refresh(id);
      expect(session.tasks.value[0].phase).toBe("unknown");
    }
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { received: 10, total: 20 }));
    await session.refresh(id);
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { received: 9, total: 20 }));
    await session.refresh(id);
    expect(session.tasks.value[0]).toMatchObject({ phase: "unknown", received: 10 });
    expect(onCommitted).not.toHaveBeenCalled();
  });
  it("bounds hanging read/cancel and total polling, without creating replacement starts", async () => {
    const id = (await session.start(input))!;
    vi.mocked(access.read).mockImplementation(() => new Promise(() => {}));
    vi.mocked(access.cancel).mockImplementation(() => new Promise(() => {}));
    const cancelling = session.cancel(id);
    await vi.advanceTimersByTimeAsync(125_000);
    await cancelling;
    expect(session.tasks.value[0]).toMatchObject({
      phase: "unknown",
      done: false,
      retryable: false,
    });
    const count = vi.mocked(access.read).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(access.read).toHaveBeenCalledTimes(count);
    expect(access.start).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("invalidates immediately, cancels exact old id, ignores late results and allows a new epoch", async () => {
    const id = (await session.start(input))!;
    const pending = deferred<DownloadState>();
    vi.mocked(access.read).mockReturnValueOnce(pending.promise);
    const reading = session.refresh(id);
    await Promise.resolve();
    current = false;
    session.invalidate();
    await Promise.resolve();
    expect(access.cancel).toHaveBeenCalledWith(id);
    expect(session.tasks.value).toEqual([]);
    current = true;
    const next = await session.start(input);
    pending.resolve(state(id, { done: true, code: "ok", committed: true, ref }));
    await reading;
    expect(session.tasks.value.map((task) => task.id)).toEqual([next]);
    expect(onCommitted).not.toHaveBeenCalled();
    session.dispose();
    await vi.advanceTimersByTimeAsync(3001);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.tasks.value).toEqual([]);
  });
  it("never unlatches Done when the pending Start later rejects", async () => {
    const start = deferred<{ operationId: string }>();
    vi.mocked(access.start).mockReturnValue(start.promise);
    const starting = session.start(input);
    const id = session.tasks.value[0].id;
    vi.mocked(access.read).mockResolvedValue(
      state(id, { done: true, code: "ok", committed: true, ref }),
    );
    await session.refresh(id);
    start.reject(new Error("late transport failure"));
    await starting;
    expect(session.tasks.value[0]).toMatchObject({ phase: "success", done: true, percent: 100 });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
  it("clears a hanging Start synchronously on disposal and consumes later rejections", async () => {
    const start = deferred<{ operationId: string }>();
    vi.mocked(access.start).mockReturnValue(start.promise);
    const starting = session.start(input);
    await Promise.resolve();
    const id = session.tasks.value[0].id;
    session.dispose();
    await vi.advanceTimersByTimeAsync(3001);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    expect(access.cancel).toHaveBeenCalledWith(id);
    await starting;
    start.reject(new Error("private late failure"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.tasks.value).toEqual([]);
    expect(access.read).not.toHaveBeenCalled();
  });
  it("retains a bounded 64-record history rather than silently recycling operations", async () => {
    for (let index = 0; index < 64; index++) {
      const id = (await session.start(input))!;
      vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "cancelled" }));
      await session.refresh(id);
    }
    expect(session.tasks.value).toHaveLength(64);
    expect(await session.start(input)).toBeUndefined();
    expect(access.start).toHaveBeenCalledTimes(64);
  });
  it("blocks unresolved and committed target aliases while allowing a renamed target", async () => {
    const id = (await session.start({ ...input, filename: "Café.mp3" }))!;
    vi.mocked(access.read).mockRejectedValueOnce(new Error("not found"));
    await session.refresh(id);
    expect(session.tasks.value[0].phase).toBe("unknown");
    expect(await session.start({ ...input, filename: "CAFE\u0301.MP3" })).toBeUndefined();
    expect(access.start).toHaveBeenCalledTimes(1);
    vi.mocked(access.read).mockResolvedValueOnce(
      state(id, { filename: "Café.mp3", done: true, code: "cancelled", committed: true }),
    );
    await session.refresh(id);
    expect(await session.start({ ...input, filename: "CAFÉ.mp3" })).toBeUndefined();
    expect(access.start).toHaveBeenCalledTimes(1);
    expect(await session.start({ ...input, filename: "renamed.mp3" })).toBeTruthy();
    expect(access.start).toHaveBeenCalledTimes(2);
  });
  it("rejects unsafe basenames and credential URLs before native calls", async () => {
    for (const filename of [
      "../a.mp3",
      "a\\b.mp3",
      ".a.mp3",
      "CON.mp3",
      "COM¹.mp3",
      "a.wav",
      "a\u0000.mp3",
    ]) {
      expect(validDownloadFilename(filename)).toBe(false);
      expect(await session.start({ ...input, filename })).toBeUndefined();
    }
    expect(
      await session.start({ ...input, url: "https://user:password@example.test/a" }),
    ).toBeUndefined();
    expect(access.start).not.toHaveBeenCalled();
  });
});

it("keeps contradictory ok-without-commit unknown and blocks a replacement Start", async () => {
  const id = (await session.start(input))!;
  vi.mocked(access.read).mockResolvedValueOnce(
    state(id, { done: true, code: "ok", committed: false }),
  );
  await session.refresh(id);
  expect(session.tasks.value[0]).toMatchObject({ phase: "unknown", done: false, retryable: false });
  expect(await session.retry(id)).toBeUndefined();
  expect(await session.start(input)).toBeUndefined();
  expect(access.start).toHaveBeenCalledTimes(1);
});

it("retires only the removed grant and bounds detached cancellation with late rejection observed", async () => {
  const cancel = deferred<DownloadState>();
  vi.mocked(access.cancel).mockReturnValue(cancel.promise);
  const old = (await session.start(input))!;
  const good = (await session.start({ ...input, grantToken: "good", filename: "good.mp3" }))!;
  session.invalidate("grant");
  expect(session.tasks.value.map((task) => task.id)).toEqual([good]);
  await vi.advanceTimersByTimeAsync(3001);
  expect(access.cancel).toHaveBeenCalledWith(old);
  expect(access.read).toHaveBeenCalledWith(good);
  expect(
    await session.start({ ...input, grantToken: "good", filename: "GOOD.MP3" }),
  ).toBeUndefined();
  session.dispose();
  await vi.advanceTimersByTimeAsync(3001);
  expect(vi.getTimerCount()).toBe(0);
  cancel.reject(new Error("late private rejection"));
  await vi.advanceTimersByTimeAsync(1);
  expect(session.tasks.value).toEqual([]);
});

it("retires a pending retry with its original grant without using a different authorization", async () => {
  const resolving = deferred<{ url: string; format: string }>();
  const resolveURL = vi.fn(() => resolving.promise);
  const id = (await session.start({ ...input, resolveURL }))!;
  vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "network_error" }));
  await session.refresh(id);
  const retrying = session.retry(id);
  await Promise.resolve();
  session.invalidate("grant");
  resolving.resolve({ url: "https://example.test/fresh", format: "mp3" });
  expect(await retrying).toBeUndefined();
  expect(await session.retry(id)).toBeUndefined();
  expect(access.start).toHaveBeenCalledTimes(1);
  expect(resolveURL).toHaveBeenCalledWith(input.quality, input.source);
});

it("bounds a never-resolving fresh retry and rejects retry after authorization expires", async () => {
  const resolveURL = vi.fn(() => new Promise<{ url: string; format: string }>(() => {}));
  const id = (await session.start({ ...input, resolveURL }))!;
  vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "cancelled" }));
  await session.refresh(id);
  const retrying = session.retry(id);
  await vi.advanceTimersByTimeAsync(3001);
  expect(await retrying).toBeUndefined();
  current = false;
  expect(await session.retry(id)).toBeUndefined();
  expect(resolveURL).toHaveBeenCalledTimes(1);
  expect(access.start).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains committed history and duplicate protection for a different live grant", async () => {
  const good = (await session.start({ ...input, grantToken: "good", filename: "good.mp3" }))!;
  vi.mocked(access.read).mockResolvedValueOnce(
    state(good, {
      filename: "good.mp3",
      code: "ok",
      done: true,
      committed: true,
      ref: { ...ref, grantToken: "good", relativePath: "good.mp3" },
    }),
  );
  await session.refresh(good);
  const removed = (await session.start(input))!;
  session.invalidate("grant");
  await Promise.resolve();
  expect(session.tasks.value).toHaveLength(1);
  expect(session.tasks.value[0]).toMatchObject({ id: good, done: true, committed: true });
  expect(access.cancel).toHaveBeenCalledWith(removed);
  expect(access.cancel).not.toHaveBeenCalledWith(good);
  expect(
    await session.start({ ...input, grantToken: "good", filename: "GOOD.mp3" }),
  ).toBeUndefined();
});

it("retries a copied immutable source without retaining the song link URL", async () => {
  const source = {
    ...input.source,
    links: input.source.links.map((link) => ({ ...link, url: "https://example.test/old?SIGNED" })),
  };
  const resolveURL = vi.fn(async () => ({ url: "https://example.test/fresh", format: "mp3" }));
  const id = (await session.start({ ...input, source, resolveURL }))!;
  source.id = "other";
  source.links[0].format = "flac";
  vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "network_error" }));
  await session.refresh(id);
  const next = await session.retry(id);
  expect(next).toBeTruthy();
  expect(next).not.toBe(id);
  expect(resolveURL).toHaveBeenCalledWith(input.quality, input.source);
  expect(JSON.stringify(vi.mocked(resolveURL).mock.calls)).not.toContain("SIGNED");
  expect(access.start).toHaveBeenLastCalledWith(
    expect.objectContaining({
      grantToken: "grant",
      filename: "song.mp3",
      url: "https://example.test/fresh",
    }),
  );
});
