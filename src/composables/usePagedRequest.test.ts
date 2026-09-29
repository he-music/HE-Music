import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";
import { usePagedRequest, type PageResult } from "./usePagedRequest";
import { useAsyncRequest } from "./useAsyncRequest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("usePagedRequest", () => {
  it("ends initial loading on failure and retries page one", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ list: [1], has_more: false });
    const request = usePagedRequest<number>(fetch);
    await request.reset();
    expect(request.loading.value).toBe(false);
    expect(request.failed.value).toBe(true);
    expect(request.data.value).toEqual([]);
    await request.retry();
    expect(fetch.mock.calls).toEqual([
      [1, ""],
      [1, ""],
    ]);
    expect(request.failed.value).toBe(false);
    expect(request.data.value).toEqual([1]);
    await request.loadMore();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps existing rows and cursor, pauses automatic loading, and retries the failed page", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ list: [1], has_more: true, last_id: "cursor-1" })
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ list: [2], has_more: false });
    const request = usePagedRequest<number>(fetch);
    await request.reset();
    await request.loadMore();
    expect(request.data.value).toEqual([1]);
    expect(request.failed.value).toBe(true);
    await request.loadMore();
    expect(fetch).toHaveBeenCalledTimes(2);
    await request.retry();
    expect(fetch.mock.calls).toEqual([
      [1, ""],
      [2, "cursor-1"],
      [2, "cursor-1"],
    ]);
    expect(request.data.value).toEqual([1, 2]);
  });

  it("ignores duplicate requests while loading", async () => {
    const pending = deferred<PageResult<number>>();
    const fetch = vi.fn(() => pending.promise);
    const request = usePagedRequest<number>(fetch);
    const first = request.reset();
    await request.retry();
    await request.loadMore();
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve({ list: [1], has_more: true });
    await first;
    expect(request.data.value).toEqual([1]);
  });

  it("discards old results after a query reset without ending the new loading state", async () => {
    const old = deferred<PageResult<number>>();
    const fresh = deferred<PageResult<number>>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const request = usePagedRequest<number>(fetch);
    const first = request.reset();
    const second = request.reset();
    old.resolve({ list: [1], has_more: false });
    await first;
    expect(request.data.value).toEqual([]);
    expect(request.loading.value).toBe(true);
    fresh.resolve({ list: [2], has_more: true });
    await second;
    expect(request.data.value).toEqual([2]);
    expect(request.hasMore.value).toBe(true);
  });

  it("ignores stale failures and disposed requests", async () => {
    const old = deferred<PageResult<number>>();
    const fresh = deferred<PageResult<number>>();
    const scope = effectScope();
    const request = scope.run(() =>
      usePagedRequest<number>(
        vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
      ),
    )!;
    const first = request.reset();
    const second = request.reset();
    old.reject(new Error("old failure"));
    await first;
    expect(request.failed.value).toBe(false);
    scope.stop();
    fresh.resolve({ list: [2], has_more: false });
    await second;
    expect(request.data.value).toEqual([]);
  });

  it("retries prerequisite initialization when it fails", async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("categories unavailable"))
      .mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ list: [1], has_more: false });
    const request = usePagedRequest<number>(async (page) => {
      if (page === 1) await initialize();
      return fetch(page);
    });
    await request.reset();
    expect(fetch).not.toHaveBeenCalled();
    await request.retry();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(1);
    expect(request.data.value).toEqual([1]);
  });
});

describe("useAsyncRequest", () => {
  it("recovers from failure and preserves a successful resource on refresh failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "artist" })
      .mockRejectedValueOnce(new Error("timeout"));
    const request = useAsyncRequest(fetch);
    await request.reset();
    expect(request.failed.value).toBe(true);
    expect(request.loading.value).toBe(false);
    await request.retry();
    expect(request.failed.value).toBe(false);
    expect(request.data.value).toEqual({ id: "artist" });
    await request.retry();
    expect(request.failed.value).toBe(true);
    expect(request.data.value).toEqual({ id: "artist" });
  });

  it("ignores duplicates and stale responses after resource changes", async () => {
    const old = deferred<string>();
    const fresh = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const request = useAsyncRequest(fetch);
    const first = request.reset();
    await request.retry();
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = request.reset();
    fresh.resolve("new artist");
    await second;
    old.resolve("old artist");
    await first;
    expect(request.data.value).toBe("new artist");
    expect(request.loading.value).toBe(false);
  });
});
