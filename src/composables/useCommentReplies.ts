import { getCurrentScope, onScopeDispose, watch } from "vue";
import { getSubComment } from "@/api/comment";
import type { CommentInfo } from "@/types/main.hemusic";
import type { CommentQuery } from "./useComments";
import type { PageResult } from "./usePagedRequest";

type FetchReplies = (
  id: string,
  platform: string,
  parentId: string,
  resourceType: string,
  page: number,
  pageSize: number,
  cursor: string,
) => Promise<PageResult<CommentInfo>>;

export function useCommentReplies(
  query: () => CommentQuery,
  fetchReplies: FetchReplies = getSubComment,
) {
  let generation = 0;
  const pending = new Set<CommentInfo>();
  const reset = () => {
    generation++;
    for (const item of pending) item.sub_loading = false;
    pending.clear();
  };

  const loadMore = async (item: CommentInfo) => {
    const source = query();
    if (
      pending.has(item) ||
      item.sub_loading ||
      !item.sub_has_more ||
      source.enabled === false ||
      !source.id ||
      !source.platform
    )
      return;
    const currentGeneration = generation;
    const page = item.sub_page_index;
    pending.add(item);
    item.sub_loading = true;
    try {
      const result = await fetchReplies(
        source.id,
        source.platform,
        item.id,
        source.resourceType,
        page,
        15,
        item.sub_last_id,
      );
      if (currentGeneration !== generation) return;
      item.sub_comments = page === 1 ? result.list : item.sub_comments.concat(result.list);
      item.sub_has_more = Boolean(result.has_more);
      item.sub_last_id = result.last_id ?? "";
      item.sub_page_index = page + 1;
    } catch {
      // 请求层展示错误，保留页码和游标供原按钮重试。
    } finally {
      if (currentGeneration === generation) {
        pending.delete(item);
        item.sub_loading = false;
      }
    }
  };

  watch(() => JSON.stringify(query()), reset, { flush: "sync" });
  if (getCurrentScope()) onScopeDispose(reset);
  return { loadMore, reset };
}
