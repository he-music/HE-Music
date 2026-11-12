import { effectScope, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComments, type CommentPage, type CommentQuery } from "./useComments";
import type { CommentInfo } from "@/types/main.hemusic";

vi.mock("@/api/comment", () => ({ getComment: vi.fn(), getSubComment: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function comment(id: string): CommentInfo {
  return {
    id,
    content: id,
    timestamp: "",
    praise_count: "0",
    user: { id: "user", name: "user", avatar: "" },
    get be_replied() {
      return this;
    },
    reply_count: "3",
    ip_location: "",
    sub_comments: [],
    sub_has_more: false,
    sub_loading: false,
    sub_last_id: "",
    sub_page_index: 1,
  };
}

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes.length = 0;
});
function setup(
  fetch: typeof import("@/api/comment").getComment,
  initial: Partial<CommentQuery> = {},
) {
  const query = reactive<CommentQuery>({
    id: "same",
    platform: "a",
    resourceType: "song",
    ...initial,
  });
  const scope = effectScope();
  scopes.push(scope);
  const request = scope.run(() => useComments(() => ({ ...query }), fetch))!;
  return { query, request, scope };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("useComments", () => {
  it("serializes repeated loads, preserves cursor on failure, and retries the same page", async () => {
    const first = deferred<CommentPage>();
    const second = deferred<CommentPage>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ list: [comment("two")], has_more: false, total_count: 2 });
    const { request } = setup(fetch);
    await request.retry();
    await request.loadMore();
    expect(fetch).toHaveBeenCalledTimes(1);
    first.resolve({ list: [comment("one")], last_id: "cursor", has_more: true, total_count: 2 });
    await flush();
    expect(request.data.value[0]).toMatchObject({ sub_has_more: true, sub_page_index: 1 });
    const next = request.loadMore();
    await request.loadMore();
    expect(fetch).toHaveBeenCalledTimes(2);
    second.reject(new Error("offline"));
    await next;
    expect(request.loading.value).toBe(false);
    expect(request.failed.value).toBe(true);
    expect(request.data.value.map((item) => item.id)).toEqual(["one"]);
    await request.retry();
    expect(fetch.mock.calls.map((args) => [args[3], args[5]])).toEqual([
      [1, ""],
      [2, "cursor"],
      [2, "cursor"],
    ]);
    expect(request.data.value.map((item) => item.id)).toEqual(["one", "two"]);
    expect(request.total.value).toBe(2);
  });

  it("ignores old data and totals on same-ID platform, resource and sort changes", async () => {
    const old = deferred<CommentPage>();
    const platform = deferred<CommentPage>();
    const hot = deferred<CommentPage>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(platform.promise)
      .mockReturnValueOnce(hot.promise);
    const { query, request } = setup(fetch);
    query.platform = "b";
    query.hot = true;
    old.resolve({ list: [comment("old")], total_count: 99, has_more: false });
    platform.reject(new Error("old platform"));
    await flush();
    expect(request.data.value).toEqual([]);
    expect(request.total.value).toBe(0);
    expect(request.loading.value).toBe(true);
    expect(request.failed.value).toBe(false);
    hot.resolve({ list: [comment("hot")], total_count: 7, has_more: true });
    await flush();
    expect(request.total.value).toBe(7);
    expect(request.data.value[0].id).toBe("hot");
    expect(fetch.mock.calls.map((args) => [args[0], args[1], args[6]])).toEqual([
      ["same", "a", undefined],
      ["same", "b", undefined],
      ["same", "b", true],
    ]);
    fetch.mockResolvedValueOnce({ list: [], total_count: 0, has_more: false });
    query.resourceType = "mv";
    await flush();
    expect(fetch.mock.lastCall?.[2]).toBe("mv");
    expect(request.data.value).toEqual([]);
  });

  it("recovers initial failure and skips unsupported or missing identities", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ list: [], has_more: false });
    const { request, query } = setup(fetch, { enabled: false });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    query.enabled = true;
    await flush();
    expect(request.failed.value).toBe(true);
    expect(request.loading.value).toBe(false);
    await request.retry();
    expect(fetch.mock.calls.map((args) => args[3])).toEqual([1, 1]);
    query.id = "";
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("discards in-flight data and totals after scope disposal", async () => {
    const pending = deferred<CommentPage>();
    const { request, scope } = setup(vi.fn(() => pending.promise));
    scope.stop();
    pending.resolve({ list: [comment("disposed")], total_count: 99, has_more: true });
    await flush();
    expect(request.data.value).toEqual([]);
    expect(request.total.value).toBe(0);
  });
});
