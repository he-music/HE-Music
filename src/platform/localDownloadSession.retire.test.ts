import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDownloadSession, type LocalDownloadAccess } from "./localDownloadSession";
import type { DownloadState } from "./mygo.bindings";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const input = {
  grantToken: "grant",
  filename: "song.mp3",
  label: "Song",
  quality: "mp3",
  source: {
    id: "song",
    platform: "test",
    name: "Song",
    links: [{ name: "mp3", quality: 320, format: "mp3", size: "1" }],
  },
  resolveURL: async () => ({ url: "https://example.test/fresh", format: "mp3" }),
  url: "https://example.test/audio",
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
let current: boolean;
let access: LocalDownloadAccess;
let session: LocalDownloadSession;
let onCommitted: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  vi.useFakeTimers();
  current = true;
  access = {
    current: () => current,
    start: vi.fn(async (request) => ({ operationId: request.operationId })),
    read: vi.fn(async (id) => state(id)),
    cancel: vi.fn(async (id) => state(id, { code: "cancelled" })),
    forget: vi.fn(async () => true),
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
async function finish() {
  const id = await session.start(input);
  if (!id) throw new Error("Missing task");
  vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "network_error" }));
  await session.refresh(id);
  return id;
}

describe("localDownloadSession retire", () => {
  it("reclaims all 64 records only after native forget and allows a fresh start", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 64; i++) ids.push(await finish());
    ids.push(await finish());
    for (const id of ids) {
      expect(await session.retire(id)).toBe(true);
      expect(await session.retire(id)).toBe(false);
    }
    expect(session.tasks.value).toEqual([]);
    expect(access.forget).toHaveBeenCalledTimes(65);
    expect(await session.start(input)).toBeTruthy();
  });
  it("rejects active, unknown, and cancellation still awaiting cleanup", async () => {
    const id = (await session.start(input))!;
    expect(await session.retire(id)).toBe(false);
    await session.cancel(id);
    expect(await session.retire(id)).toBe(false);
    vi.mocked(access.read).mockRejectedValueOnce(new Error("transport"));
    await session.refresh(id);
    expect(session.tasks.value[0].phase).toBe("unknown");
    expect(await session.retire(id)).toBe(false);
    expect(access.forget).not.toHaveBeenCalled();
  });
  it("keeps records when forget is absent, rejected, false, or times out", async () => {
    const id = await finish();
    const forget = access.forget;
    access.forget = undefined;
    expect(await session.retire(id)).toBe(false);
    access.forget = forget;
    if (!forget) throw new Error("Missing forget fake");
    vi.mocked(forget).mockRejectedValueOnce(new Error("denied"));
    expect(await session.retire(id)).toBe(false);
    vi.mocked(forget).mockResolvedValueOnce(false);
    expect(await session.retire(id)).toBe(false);
    const late = deferred<boolean>();
    vi.mocked(forget).mockReturnValueOnce(late.promise);
    const pending = session.retire(id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(false);
    late.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.tasks.value.map((task) => task.id)).toEqual([id]);
    expect(await session.retire(id)).toBe(true);
    expect(session.tasks.value).toEqual([]);
  });
  it("serializes retire and blocks retry while native retirement is pending", async () => {
    const id = await finish();
    const late = deferred<boolean>();
    if (!access.forget) throw new Error("Missing forget fake");
    vi.mocked(access.forget).mockReturnValueOnce(late.promise);
    const pending = session.retire(id);
    expect(await session.retire(id)).toBe(false);
    expect(await session.retry(id)).toBeUndefined();
    late.resolve(true);
    expect(await pending).toBe(true);
    expect(access.forget).toHaveBeenCalledTimes(1);
  });
  it("rejects retirement while a prior read or retry resolver is pending", async () => {
    const id = (await session.start(input))!;
    const old = deferred<DownloadState>();
    vi.mocked(access.read).mockReturnValueOnce(old.promise);
    const reading = session.refresh(id);
    await session.cancel(id);
    vi.mocked(access.read).mockResolvedValueOnce(state(id, { done: true, code: "network_error" }));
    await session.refresh(id);
    expect(await session.retire(id)).toBe(false);
    old.resolve(state(id));
    await reading;
    expect(await session.retire(id)).toBe(true);

    const resolver = deferred<{ url: string; format: string }>();
    const retryID = (await session.start({ ...input, resolveURL: () => resolver.promise }))!;
    vi.mocked(access.read).mockResolvedValueOnce(
      state(retryID, { done: true, code: "network_error" }),
    );
    await session.refresh(retryID);
    const retry = session.retry(retryID);
    expect(await session.retire(retryID)).toBe(false);
    resolver.resolve({ url: "https://example.test/fresh", format: "mp3" });
    await retry;
  });
  it("waits for committed metadata refresh before retiring a successful download", async () => {
    const id = (await session.start(input))!;
    const metadata = deferred<void>();
    onCommitted.mockReturnValueOnce(metadata.promise);
    vi.mocked(access.read).mockResolvedValueOnce(
      state(id, {
        done: true,
        code: "ok",
        committed: true,
        ref: { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "version" },
      }),
    );
    const reading = session.refresh(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.tasks.value[0].refresh).toBe("pending");
    expect(await session.retire(id)).toBe(false);
    metadata.resolve();
    await reading;
    expect(await session.retire(id)).toBe(true);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
  it("drops late retire acknowledgments across grant invalidation and owner replacement", async () => {
    for (const token of ["grant", undefined]) {
      const id = await finish();
      const late = deferred<boolean>();
      if (!access.forget) throw new Error("Missing forget fake");
      vi.mocked(access.forget).mockReturnValueOnce(late.promise);
      const pending = session.retire(id);
      await Promise.resolve();
      current = false;
      session.invalidate(token);
      current = true;
      const next = await finish();
      late.resolve(true);
      expect(await pending).toBe(false);
      expect(session.tasks.value.map((task) => task.id)).toEqual([next]);
      expect(await session.retire(next)).toBe(true);
    }
  });
});
