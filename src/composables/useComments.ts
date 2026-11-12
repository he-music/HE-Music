import { getCurrentScope, onScopeDispose, reactive, ref, watch } from "vue";
import { getComment } from "@/api/comment";
import type { CommentInfo } from "@/types/main.hemusic";
import { usePagedRequest, type PageResult } from "./usePagedRequest";
import { useCommentReplies } from "./useCommentReplies";

export interface CommentQuery {
  id: string;
  platform: string;
  resourceType: "song" | "mv" | "album" | "playlist";
  hot?: boolean;
  enabled?: boolean;
}

export interface CommentPage extends PageResult<CommentInfo> {
  total_count?: number;
}

export function useComments(
  query: () => CommentQuery,
  fetchComments: typeof getComment = getComment,
) {
  const total = ref(0);
  let generation = 0;
  const replies = useCommentReplies(query);
  const request = usePagedRequest<CommentInfo>(async (page, cursor) => {
    const source = query();
    const currentGeneration = generation;
    if (source.enabled === false || !source.id || !source.platform) {
      return { list: [], has_more: false };
    }
    const result: CommentPage = await fetchComments(
      source.id,
      source.platform,
      source.resourceType,
      page,
      20,
      cursor,
      source.hot,
    );
    if (currentGeneration === generation) total.value = result.total_count ?? 0;
    return {
      ...result,
      list: result.list.map((item) =>
        reactive({
          ...item,
          sub_has_more: Number(item.reply_count) > item.sub_comments.length,
          sub_loading: false,
          sub_last_id: "",
          sub_page_index: 1,
        }),
      ),
    };
  });

  const reset = () => {
    generation++;
    total.value = 0;
    replies.reset();
    return request.reset();
  };
  watch(() => JSON.stringify(query()), reset, { immediate: true, flush: "sync" });
  if (getCurrentScope()) onScopeDispose(() => generation++);

  return { ...request, reset, total, loadSubMore: replies.loadMore };
}
