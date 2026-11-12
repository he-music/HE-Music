import { effectScope, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommentReplies } from "./useCommentReplies";
import type { CommentQuery } from "./useComments";
import type { CommentInfo } from "@/types/main.hemusic";
import type { PageResult } from "./usePagedRequest";

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
  return reactive({
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
    sub_has_more: true,
    sub_loading: false,
    sub_last_id: "",
    sub_page_index: 1,
  });
}
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes.length = 0;
});
function setup(fetch: Parameters<typeof useCommentReplies>[1]) {
  const query = reactive<CommentQuery>({ id: "song", platform: "a", resourceType: "song" });
  const scope = effectScope();
  scopes.push(scope);
  const request = scope.run(() => useCommentReplies(() => ({ ...query }), fetch))!;
  return { query, request, scope };
}

describe("useCommentReplies", () => {
  it("blocks duplicates, replaces preview replies on page one, and commits pagination after success", async () => {
    const first = deferred<PageResult<CommentInfo>>();
    const second = deferred<PageResult<CommentInfo>>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ list: [comment("second")], has_more: false, last_id: "end" });
    const { request } = setup(fetch);
    const item = comment("parent");
    item.sub_comments = [comment("preview")];
    const loading = request.loadMore(item);
    await request.loadMore(item);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(item.sub_page_index).toBe(1);
    first.resolve({ list: [comment("first")], has_more: true, last_id: "cursor" });
    await loading;
    expect(item.sub_comments.map((reply) => reply.id)).toEqual(["first"]);
    expect(item.sub_page_index).toBe(2);
    const failing = request.loadMore(item);
    second.reject(new Error("offline"));
    await failing;
    expect(item.sub_loading).toBe(false);
    expect(item.sub_page_index).toBe(2);
    expect(item.sub_last_id).toBe("cursor");
    await request.loadMore(item);
    expect(fetch.mock.calls.map((args) => [args[4], args[6]])).toEqual([
      [1, ""],
      [2, "cursor"],
      [2, "cursor"],
    ]);
    expect(item.sub_comments.map((reply) => reply.id)).toEqual(["first", "second"]);
    expect(item.sub_page_index).toBe(3);
    await request.loadMore(item);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("ignores stale success after same-ID platform changes while new replies remain loading", async () => {
    const old = deferred<PageResult<CommentInfo>>();
    const fresh = deferred<PageResult<CommentInfo>>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { request, query } = setup(fetch);
    const oldItem = comment("same-parent");
    const first = request.loadMore(oldItem);
    query.platform = "b";
    expect(oldItem.sub_loading).toBe(false);
    const freshItem = comment("same-parent");
    const second = request.loadMore(freshItem);
    old.resolve({ list: [comment("stale")], has_more: false });
    await first;
    expect(oldItem.sub_comments).toEqual([]);
    expect(oldItem.sub_page_index).toBe(1);
    expect(freshItem.sub_loading).toBe(true);
    fresh.resolve({ list: [comment("fresh")], has_more: false });
    await second;
    expect(freshItem.sub_comments[0].id).toBe("fresh");
    expect(fetch.mock.calls.map((args) => [args[0], args[1]])).toEqual([
      ["song", "a"],
      ["song", "b"],
    ]);
  });

  it("clears pending indicators and discards replies after sort change, reset or disposal", async () => {
    const pending = deferred<PageResult<CommentInfo>>();
    const fetch = vi.fn(() => pending.promise);
    const { request, query, scope } = setup(fetch);
    const item = comment("parent");
    const first = request.loadMore(item);
    query.hot = true;
    expect(item.sub_loading).toBe(false);
    const second = request.loadMore(item);
    request.reset();
    expect(item.sub_loading).toBe(false);
    const third = request.loadMore(item);
    scope.stop();
    expect(item.sub_loading).toBe(false);
    pending.resolve({ list: [comment("stale")], has_more: false });
    await Promise.all([first, second, third]);
    expect(item.sub_comments).toEqual([]);
    expect(item.sub_page_index).toBe(1);
  });

  it("does not request replies when the capability is disabled", async () => {
    const fetch = vi.fn();
    const { request, query } = setup(fetch);
    query.enabled = false;
    await request.loadMore(comment("parent"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
